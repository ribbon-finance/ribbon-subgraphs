import { Address, BigInt, Bytes, log } from "@graphprotocol/graph-ts";
import {
  OpenShort,
  CloseShort,
  Deposit,
  Withdraw,
  Transfer,
  InitiateGnosisAuction,
  InitiateWithdraw,
  InstantWithdraw
} from "../generated/RibbonETHCoveredCall/RibbonThetaVault";
import {
  Vault,
  VaultShortPosition,
  GnosisAuction,
  VaultOptionTrade,
  VaultTransaction,
  VaultAccount,
  VaultPerformanceUpdate
} from "../generated/schema";
import { RibbonThetaVault } from "../generated/RibbonETHCoveredCall/RibbonThetaVault";
import { Otoken } from "../generated/RibbonETHCoveredCall/Otoken";
import { AuctionCleared } from "../generated/GnosisAuction/GnosisAuction";

import {
  createVaultAccount,
  refreshAllAccountBalances,
  triggerBalanceUpdate
} from "./accounts";
import { getOtokenMintAmount, getPricePerShare, sharesToAssets } from "./utils";
import { updateVaultPerformance } from "./vaultPerformance";

function newVault(vaultAddress: string, creationTimestamp: i32): Vault {
  let vault = new Vault(vaultAddress);
  let vaultContract = RibbonThetaVault.bind(Address.fromString(vaultAddress));
  let assetAddress = vaultContract.vaultParams().value2;
  let asset = Otoken.bind(assetAddress);

  vault.name = vaultContract.name();
  vault.symbol = vaultContract.symbol();
  vault.numDepositors = 0;
  vault.depositors = [];
  vault.totalPremiumEarned = BigInt.fromI32(0);
  vault.cap = vaultContract.cap();
  vault.round = 1;
  vault.totalBalance = vaultContract.totalBalance();
  vault.underlyingAsset = assetAddress;
  vault.underlyingName = asset.name();
  vault.underlyingSymbol = asset.symbol();
  vault.underlyingDecimals = asset.decimals();
  vault.performanceUpdateCounter = 0;

  // We create an initial VaultPerformanceUpdate with the default pricePerShare
  let performanceUpdate = new VaultPerformanceUpdate(vaultAddress + "-0");
  performanceUpdate.vault = vault.id;
  performanceUpdate.pricePerShare = BigInt.fromI32(10).pow(
    u8(vault.underlyingDecimals)
  );
  performanceUpdate.timestamp = creationTimestamp;
  performanceUpdate.save();

  return vault;
}

export function handleOpenShort(event: OpenShort): void {
  let optionAddress = event.params.options;

  let vault = Vault.load(event.address.toHexString());
  vault.round = vault.round + 1;
  vault.save();

  let shortPosition = new VaultShortPosition(optionAddress.toHexString());

  let otoken = Otoken.bind(optionAddress);
  shortPosition.expiry = otoken.expiryTimestamp();
  let strikePrice = otoken.strikePrice();
  let isPut = otoken.isPut();
  shortPosition.strikePrice = strikePrice;

  let collateral = Otoken.bind(otoken.collateralAsset());
  let collateralDecimals = collateral.decimals() as u8;

  let vaultAddress = event.address.toHexString();
  shortPosition.vault = vaultAddress;
  shortPosition.option = optionAddress;
  shortPosition.depositAmount = event.params.depositAmount;
  shortPosition.mintAmount = getOtokenMintAmount(
    event.params.depositAmount,
    strikePrice,
    collateralDecimals,
    isPut
  );
  shortPosition.initiatedBy = event.params.manager;
  shortPosition.openedAt = event.block.timestamp;
  shortPosition.openTxhash = event.transaction.hash;

  shortPosition.save();
}

export function handleCloseShort(event: CloseShort): void {
  let vaultAddress = event.address.toHexString();

  let shortPosition = VaultShortPosition.load(
    event.params.options.toHexString()
  );
  if (shortPosition != null) {
    let vault = Vault.load(vaultAddress);
    if (vault == null) {
      vault = newVault(vaultAddress, event.block.timestamp.toI32());
    }
    vault.save();

    updateVaultPerformance(vaultAddress, event.block.timestamp.toI32());

    let loss = shortPosition.depositAmount - event.params.withdrawAmount;
    shortPosition.loss = loss;
    shortPosition.withdrawAmount = event.params.withdrawAmount;
    shortPosition.isExercised = loss > BigInt.fromI32(0);
    shortPosition.closedAt = event.block.timestamp;
    shortPosition.closeTxhash = event.transaction.hash;
    shortPosition.save();

    refreshAllAccountBalances(
      Address.fromString(vaultAddress),
      event.block.timestamp.toI32()
    );
  }
}

// // Used for mapping of AuctionCleared to RibbonVault
export function handleInitiateGnosisAuction(
  event: InitiateGnosisAuction
): void {
  let auctionID = event.params.auctionCounter;
  let optionToken = event.params.auctioningToken;

  let auction = new GnosisAuction(auctionID.toHexString());
  auction.optionToken = optionToken;
  auction.save();
}

export function handleAuctionCleared(event: AuctionCleared): void {
  let auctionID = event.params.auctionId;
  let auction = GnosisAuction.load(auctionID.toHexString());
  if (auction == null) {
    return;
  }

  let optionToken = auction.optionToken;
  let shortPosition = VaultShortPosition.load(optionToken.toHexString());
  if (shortPosition == null) {
    return;
  }

  let vault = Vault.load(shortPosition.vault);
  if (vault == null) {
    return;
  }

  updateVaultPerformance(shortPosition.vault, event.block.timestamp.toI32());

  let tradeID =
    optionToken.toHexString() +
    "-" +
    event.transaction.hash.toHexString() +
    "-" +
    event.transactionLogIndex.toString();

  let optionsSold = event.params.soldAuctioningTokens;
  let totalPremium = event.params.soldBiddingTokens;

  let optionTrade = new VaultOptionTrade(tradeID);
  optionTrade.vault = shortPosition.vault;

  optionTrade.sellAmount = optionsSold;
  optionTrade.premium = totalPremium;

  optionTrade.vaultShortPosition = optionToken.toHexString();
  optionTrade.timestamp = event.block.timestamp;
  optionTrade.txhash = event.transaction.hash;
  optionTrade.save();

  shortPosition.premiumEarned = shortPosition.premiumEarned.plus(totalPremium);
  shortPosition.save();

  vault.totalPremiumEarned = vault.totalPremiumEarned.plus(totalPremium);
  vault.save();

  refreshAllAccountBalances(
    Address.fromString(shortPosition.vault),
    event.block.timestamp.toI32()
  );
}

export function handleDeposit(event: Deposit): void {
  let vaultAddress = event.address.toHexString();
  let vault = Vault.load(vaultAddress);

  if (vault == null) {
    vault = newVault(vaultAddress, event.block.timestamp.toI32());
    vault.save();
  }

  let vaultAccount = createVaultAccount(event.address, event.params.account);
  vaultAccount.totalDeposits = vaultAccount.totalDeposits + event.params.amount;
  vaultAccount.depositInRound = vault.round;
  vaultAccount.save();

  let txid =
    vaultAddress +
    "-" +
    event.transaction.hash.toHexString() +
    "-" +
    event.transactionLogIndex.toString();

  newTransaction(
    txid,
    "deposit",
    vaultAddress,
    event.params.account,
    event.transaction.hash,
    event.block.timestamp,
    event.params.amount,
    event.params.amount
  );

  triggerBalanceUpdate(
    event.address,
    event.params.account,
    event.block.timestamp.toI32(),
    false,
    false
  );
}

export function handleInitiateWithdraw(event: InitiateWithdraw): void {
  let vaultAddress = event.address.toHexString();
  let vault = Vault.load(vaultAddress);
  let vaultAccount = createVaultAccount(event.address, event.params.account);
  vaultAccount.save();

  let txid =
    vaultAddress +
    "-" +
    event.transaction.hash.toHexString() +
    "-" +
    event.transactionLogIndex.toString();

  let vaultContract = RibbonThetaVault.bind(event.address);

  let decimals = vault.underlyingDecimals;
  let assetAmount = sharesToAssets(
    event.params.shares,
    getPricePerShare(vaultContract, decimals),
    decimals
  );

  newTransaction(
    txid,
    "initiateWithdraw",
    vaultAddress,
    event.params.account,
    event.transaction.hash,
    event.block.timestamp,
    event.params.shares,
    assetAmount
  );

  triggerBalanceUpdate(
    event.address,
    event.params.account,
    event.block.timestamp.toI32(),
    false,
    true
  );
}

export function handleWithdraw(event: Withdraw): void {
  let vaultAddress = event.address.toHexString();
  let vault = Vault.load(vaultAddress);

  if (vault == null) {
    vault = newVault(vaultAddress, event.block.timestamp.toI32());
    vault.save();
  }

  let vaultAccount = createVaultAccount(event.address, event.params.account);
  vaultAccount.totalDeposits = vaultAccount.totalDeposits - event.params.amount;
  vaultAccount.save();

  let txid =
    vaultAddress +
    "-" +
    event.transaction.hash.toHexString() +
    "-" +
    event.transactionLogIndex.toString();

  newTransaction(
    txid,
    "withdraw",
    vaultAddress,
    event.params.account,
    event.transaction.hash,
    event.block.timestamp,
    event.params.amount,
    event.params.amount
  );

  triggerBalanceUpdate(
    event.address,
    event.params.account,
    event.block.timestamp.toI32(),
    false,
    true
  );
}

export function handleInstantWithdraw(event: InstantWithdraw): void {
  // The vault & vaultAccount must already exist before an instantwithdraw is triggered
  // This is because we create them on deposit
  let vaultAddress = event.address.toHexString();

  let txid =
    vaultAddress +
    "-" +
    event.transaction.hash.toHexString() +
    "-" +
    event.transactionLogIndex.toString();

  let vaultAccountID = vaultAddress + "-" + event.params.account.toHexString();
  let vaultAccount = VaultAccount.load(vaultAccountID);
  vaultAccount.totalDeposits = vaultAccount.totalDeposits - event.params.amount;
  vaultAccount.save();

  newTransaction(
    txid,
    "instantWithdraw",
    vaultAddress,
    event.params.account,
    event.transaction.hash,
    event.block.timestamp,
    event.params.amount,
    event.params.amount
  );

  triggerBalanceUpdate(
    event.address,
    event.params.account,
    event.block.timestamp.toI32(),
    false,
    true
  );
}

/**
 * We have two types of transfer
 *
 * Liquidity Mining
 * In liquidity mining, we keep track of the amount as shares, and underlying as actual underlying amount
 *
 * Normal transfer
 * We will store both underlying and amount as asset amount. In this case, the user transfer "underlying" instead of shares.
 */
export function handleTransfer(event: Transfer): void {
  // Just skip if it's a new deposit or withdrawal
  if (
    event.params.from.toHexString() ==
      "0x0000000000000000000000000000000000000000" ||
    event.params.to.toHexString() ==
      "0x0000000000000000000000000000000000000000" ||
    event.params.from.toHexString() == event.address.toHexString() ||
    event.params.to.toHexString() == event.address.toHexString()
  ) {
    return;
  }

  let vaultAddress = event.address.toHexString();
  let vault = Vault.load(vaultAddress);
  let txid =
    vaultAddress +
    "-" +
    event.transaction.hash.toHexString() +
    "-" +
    event.transactionLogIndex.toString();

  /**
   * Calculate underlying amount
   * Staking: To be able to calculate USD value that had been staked
   * Transfer: Transfer are always in the unit of underlying
   */
  let vaultContract = RibbonThetaVault.bind(event.address);

  let decimals = vault.underlyingDecimals;
  let underlyingAmount = sharesToAssets(
    event.params.value,
    getPricePerShare(vaultContract, decimals),
    decimals
  );

  /**
   * Record sender deposit/withdraw amount
   */
  let senderVaultAccount = createVaultAccount(event.address, event.params.from);
  senderVaultAccount.totalDeposits =
    senderVaultAccount.totalDeposits - underlyingAmount;
  senderVaultAccount.save();

  newTransaction(
    txid + "-T", // Indicate transfer
    "transfer",
    vaultAddress,
    event.params.from,
    event.transaction.hash,
    event.block.timestamp,
    underlyingAmount,
    underlyingAmount
  );

  /**
   * Record receiver deposit/withdraw amount
   */
  let receiverVaultAccount = createVaultAccount(event.address, event.params.to);
  receiverVaultAccount.totalDeposits =
    receiverVaultAccount.totalDeposits + underlyingAmount;
  receiverVaultAccount.save();

  newTransaction(
    txid + "-R", // Indicate receive
    "receive",
    vaultAddress,
    event.params.to,
    event.transaction.hash,
    event.block.timestamp,
    underlyingAmount,
    underlyingAmount
  );

  triggerBalanceUpdate(
    event.address,
    event.params.from,
    event.block.timestamp.toI32(),
    false,
    true
  );
  triggerBalanceUpdate(
    event.address,
    event.params.to,
    event.block.timestamp.toI32(),
    false,
    false
  );
}

function newTransaction(
  txid: string,
  type: string,
  vaultAddress: string,
  account: Address,
  txhash: Bytes,
  timestamp: BigInt,
  amount: BigInt,
  underlyingAmount: BigInt
): void {
  let transaction = new VaultTransaction(txid);
  transaction.type = type;
  transaction.vault = vaultAddress;
  transaction.address = account;
  transaction.txhash = txhash;
  transaction.timestamp = timestamp;
  transaction.amount = amount;
  transaction.underlyingAmount = underlyingAmount || amount;
  transaction.save();
}
