import { Address, BigInt } from "@graphprotocol/graph-ts";
import { RibbonThetaVault } from "../generated/RibbonETHCoveredCall/RibbonThetaVault";

let WAD = BigInt.fromString("1000000000000000000");
let OTOKEN_DECIMALS = BigInt.fromString("100000000");
let SCALE_DECIMALS = BigInt.fromString("10000000000");

function wdiv(x: BigInt, y: BigInt): BigInt {
  return x
    .times(WAD)
    .plus(y.div(BigInt.fromI32(2)))
    .div(y);
}

export function getOtokenMintAmount(
  depositAmount: BigInt,
  strikePrice: BigInt,
  collateralDecimals: u8,
  isPut: bool
): BigInt {
  if (isPut) {
    return wdiv(
      depositAmount.times(OTOKEN_DECIMALS),
      strikePrice.times(SCALE_DECIMALS)
    ).div(BigInt.fromI32(10).pow(collateralDecimals));
  }

  let scaleByDecimals = BigInt.fromI32(10).pow(collateralDecimals - 8);
  return depositAmount.div(scaleByDecimals);
}

export function getPricePerShare(
  vault: RibbonThetaVault,
  decimals: number
): BigInt {
  let callResult = vault.try_pricePerShare();
  // If it reverts it means that the supply is 0, so we return a single share
  if (callResult.reverted) {
    let decimalsU8: u8 = u8(decimals);
    return BigInt.fromI32(10).pow(decimalsU8);
  }
  return callResult.value;
}

export function sharesToAssets(
  shareAmount: BigInt,
  assetPerShare: BigInt,
  decimals: number
): BigInt {
  let decimalsU8: u8 = u8(decimals);
  let singleShare = BigInt.fromI32(10).pow(decimalsU8);
  return (shareAmount * assetPerShare) / singleShare;
}

export function getTotalPendingDeposit(
  vault: RibbonThetaVault,
  account: Address
): BigInt {
  let vaultState = vault.vaultState();
  let currentRound = vaultState.value0;

  let depositReceipt = vault.depositReceipts(account);
  let receiptRound = depositReceipt.value0;
  let depositAmount = depositReceipt.value1;

  if (receiptRound <= currentRound) {
    return depositAmount;
  }
  return BigInt.fromI32(0);
}
