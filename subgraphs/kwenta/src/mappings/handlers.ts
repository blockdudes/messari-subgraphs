import { TokenPricer, ProtocolConfig } from "../sdk/protocols/config";
import { SDK } from "../sdk/protocols/perpfutures";
import { NetworkConfigs } from "../../configurations/configure";
import { Versions } from "../versions";
import {
  _SmartMarginAccount,
  Token,
  _FundingRate,
} from "../../generated/schema";
import { _ERC20 } from "../../generated/FuturesMarketManager1/_ERC20";
import {
  Address,
  BigDecimal,
  BigInt,
  Bytes,
  dataSource,
  log,
} from "@graphprotocol/graph-ts";
import { getUsdPrice, getUsdPricePerToken } from "../prices";
import {
  bigDecimalToBigInt,
  bigIntToBigDecimal,
  safeDivide,
} from "../sdk/util/numbers";

import {
  TokenInitializer,
  TokenParams,
} from "../sdk/protocols/perpfutures/tokens";
import {
  BIGDECIMAL_MINUS_ONE,
  BIGINT_MINUS_ONE,
  LiquidityPoolFeeType,
  PositionSide,
} from "../sdk/util/constants";
import {
  MarketAdded as MarketAddedEvent,
  MarketRemoved,
} from "../../generated/FuturesMarketManager1/FuturesMarketManager";
import {
  FundingRecomputed as FundingRecomputedEvent,
  MarginTransferred as MarginTransferredEvent,
  PositionLiquidated as PositionLiquidatedEvent,
  PositionModified as PositionModifiedEvent,
} from "../../generated/templates/FuturesV1Market/FuturesMarket";
import {
  PositionLiquidated as PositionLiquidatedV2Event,
  PositionModified as PositionModifiedV2Event,
} from "../../generated/templates/PerpsV2Market/PerpsV2MarketProxyable";
import { FuturesV1Market, PerpsV2Market } from "../../generated/templates";
import { createTokenAmountArray, getFundingRateId } from "./helpers";
import { BIGDECIMAL_ZERO, BIGINT_ZERO } from "../common/constants";
import { NewAccount as NewSmartMarginAccountEvent } from "../../generated/SmartMarginFactory1/SmartMarginFactory";

class Pricer implements TokenPricer {
  getTokenPrice(token: Token): BigDecimal {
    const price = getUsdPricePerToken(Address.fromBytes(token.id));
    return price.usdPrice;
  }

  getAmountValueUSD(token: Token, amount: BigInt): BigDecimal {
    const _amount = bigIntToBigDecimal(amount, token.decimals);
    return getUsdPrice(Address.fromBytes(token.id), _amount);
  }
}

// Implement TokenInitializer
class TokenInit implements TokenInitializer {
  getTokenParams(address: Address): TokenParams {
    const erc20 = _ERC20.bind(address);
    const name = erc20.name();
    const symbol = erc20.symbol();
    const decimals = erc20.decimals().toI32();
    return {
      name,
      symbol,
      decimals,
    };
  }
}

const conf = new ProtocolConfig(
  NetworkConfigs.getFactoryAddress().toHexString(),
  NetworkConfigs.getProtocolName(),
  NetworkConfigs.getProtocolSlug(),
  Versions
);

export function handleV1MarketAdded(event: MarketAddedEvent): void {
  const marketKey = event.params.marketKey.toString();
  const sdk = SDK.initializeFromEvent(
    conf,
    new Pricer(),
    new TokenInit(),
    event
  );

  const pool = sdk.Pools.loadPool(event.params.market);
  if (!pool.isInitialized) {
    const token = sdk.Tokens.getOrCreateToken(NetworkConfigs.getSUSDAddress());
    pool.initialize(marketKey, marketKey, [token], null, "chainlink");
    // todo: fees
  }

  // check that it's a v1 market before adding
  if (marketKey.startsWith("s") && !marketKey.endsWith("PERP")) {
    log.info("New V1 market added: {}", [marketKey]);

    // futures v1 market
    FuturesV1Market.create(event.params.market);
  }
}
export function handleV2MarketAdded(event: MarketAddedEvent): void {
  const marketKey = event.params.marketKey.toString();
  const sdk = SDK.initializeFromEvent(
    conf,
    new Pricer(),
    new TokenInit(),
    event
  );

  const pool = sdk.Pools.loadPool(event.params.market);
  if (!pool.isInitialized) {
    const token = sdk.Tokens.getOrCreateToken(NetworkConfigs.getSUSDAddress());
    pool.initialize(marketKey, marketKey, [token], null, "chainlink");
    // todo: fees
  }

  // check that it's a v1 market before adding
  if (marketKey.endsWith("PERP")) {
    log.info("New V2 market added: {}", [marketKey]);

    // perps v2 market
    PerpsV2Market.create(event.params.market);
  }
}

export function handleNewAccountSmartMarge(
  event: NewSmartMarginAccountEvent
): void {
  // create a new entity to store the cross-margin account owner
  const smAccountAddress = event.params.account as Address;
  let smartMarginAccount = _SmartMarginAccount.load(smAccountAddress.toHex());
  const sdk = SDK.initializeFromEvent(
    conf,
    new Pricer(),
    new TokenInit(),
    event
  );
  if (smartMarginAccount == null) {
    smartMarginAccount = new _SmartMarginAccount(smAccountAddress.toHex());

    const loadAccountResponse = sdk.Accounts.loadAccount(event.params.creator);
    if (loadAccountResponse.isNewUser) {
      const protocol = sdk.Protocol;
      protocol.addUser();
    }
    smartMarginAccount.owner = loadAccountResponse.account.getBytesId();

    smartMarginAccount.version = event.params.version;
    smartMarginAccount.save();
  }
}

export function handleMarginTransferred(event: MarginTransferredEvent): void {
  let marketAddress = dataSource.address();
  const marginDelta = event.params.marginDelta;
  const caller = event.params.account;

  const sdk = SDK.initializeFromEvent(
    conf,
    new Pricer(),
    new TokenInit(),
    event
  );
  const pool = sdk.Pools.loadPool(marketAddress);
  const token = sdk.Tokens.getOrCreateToken(NetworkConfigs.getSUSDAddress());

  const loadAccountResponse = sdk.Accounts.loadAccount(caller);
  const account = loadAccountResponse.account;
  if (loadAccountResponse.isNewUser) {
    const protocol = sdk.Protocol;
    protocol.addUser();
    pool.addUser();
  }
  const amounts = createTokenAmountArray(pool, [token], [marginDelta.abs()]);

  const position = sdk.Positions.loadPosition(
    pool,
    account,
    token,
    token,
    "",
    null,
    true
  );
  if (marginDelta.gt(BIGINT_ZERO)) {
    account.collateralIn(pool, position.getBytesID(), amounts, BIGINT_ZERO);
    position.addCollateralInCount();
    pool.addInflowVolumeByToken(token, marginDelta.abs());
    pool.addVolumeByToken(token, marginDelta.abs());
  }
  if (marginDelta.lt(BIGINT_ZERO)) {
    account.collateralOut(pool, position.getBytesID(), amounts, BIGINT_ZERO);
    position.addCollateralOutCount();
    pool.addOutflowVolumeByToken(token, marginDelta.abs());
    pool.addVolumeByToken(token, marginDelta.abs());
  }
}
export function handleFundingRecomputed(event: FundingRecomputedEvent): void {
  const marketAddress = dataSource.address();
  const fundingRate = event.params.funding;

  const sdk = SDK.initializeFromEvent(
    conf,
    new Pricer(),
    new TokenInit(),
    event
  );
  const pool = sdk.Pools.loadPool(marketAddress);
  let fundingRateEntity = new _FundingRate(
    pool
      .getBytesID()
      .concat(Bytes.fromUTF8("-"))
      .concatI32(event.params.index.toI32())
  );
  fundingRateEntity.funding = event.params.funding;
  fundingRateEntity.save();
  pool.setFundingRate([bigIntToBigDecimal(fundingRate)]);
}
export function handlePositionModified(event: PositionModifiedEvent): void {
  const marketAddress = dataSource.address();
  const sdk = SDK.initializeFromEvent(
    conf,
    new Pricer(),
    new TokenInit(),
    event
  );
  const pool = sdk.Pools.loadPool(marketAddress);
  const isClose = event.params.size.isZero();
  let sendingAccount = event.params.account;

  let smartMarginAccount = _SmartMarginAccount.load(sendingAccount.toHex());

  const accountAddress = smartMarginAccount
    ? Address.fromBytes(smartMarginAccount.owner)
    : sendingAccount;

  const loadAccountResponse = sdk.Accounts.loadAccount(accountAddress);
  const account = loadAccountResponse.account;
  if (loadAccountResponse.isNewUser) {
    const protocol = sdk.Protocol;
    protocol.addUser();
    pool.addUser();
  }

  const token = sdk.Tokens.getOrCreateToken(NetworkConfigs.getSUSDAddress());
  const isLong = event.params.size.gt(BIGINT_ZERO);
  const position = sdk.Positions.loadPosition(
    pool,
    account,
    token,
    token,
    isLong ? PositionSide.LONG : PositionSide.SHORT,
    event,
    true
  );
  const fees = event.params.fee;

  const positionData = position.position;

  if (event.params.tradeSize.gt(BIGINT_ZERO)) {
    const previousFunding = _FundingRate.load(
      getFundingRateId(pool, positionData.fundingIndex)
    )!;
    const currentFunding = _FundingRate.load(
      getFundingRateId(pool, event.params.fundingIndex)
    )!;
    const fundingAccrued = currentFunding.funding
      .minus(previousFunding.funding)
      .times(positionData.size);

    const positionSize = event.params.size;

    if (isClose) {
      const pnl = event.params.lastPrice
        .minus(positionData.price)
        .times(positionSize)
        .minus(fundingAccrued)
        .minus(fees);

      const totalMarginRemaining = event.params.margin;

      position.setBalanceClosed(token, totalMarginRemaining);
      position.setCollateralBalanceClosed(token, totalMarginRemaining);
      position.setRealisedPnlClosed(token, pnl);
      position.setFundingrateClosed(bigIntToBigDecimal(currentFunding.funding));
      position.closePosition();
    } else {
      const newPosition = sdk.Positions.loadPosition(
        pool,
        account,
        token,
        token,
        isLong ? PositionSide.LONG : PositionSide.SHORT,
        event,
        false
      );
      const totalMarginRemaining = event.params.margin;

      const positionTotalPrice = event.params.lastPrice.times(positionSize);
      const leverage = positionTotalPrice.div(totalMarginRemaining);

      if (newPosition.getBytesID() != position.getBytesID()) {
        const pnl = event.params.lastPrice
          .minus(positionData.price)
          .times(positionSize)
          .minus(fundingAccrued)
          .minus(fees);
        position.setBalanceClosed(token, totalMarginRemaining);
        position.setCollateralBalanceClosed(token, totalMarginRemaining);
        position.setRealisedPnlClosed(token, pnl);
        position.setFundingrateClosed(
          bigIntToBigDecimal(currentFunding.funding)
        );
        position.setFundingrateClosed(
          bigIntToBigDecimal(currentFunding.funding)
        );
        position.closePosition();
      }

      newPosition.setBalance(token, totalMarginRemaining);
      newPosition.setCollateralBalance(token, totalMarginRemaining);
      newPosition.setPrice(event.params.lastPrice);
      newPosition.setSize(event.params.size);
      newPosition.setFundingIndex(event.params.fundingIndex);
      newPosition.setLeverage(bigIntToBigDecimal(leverage));
    }
  }

  pool.addRevenueByToken(token, BIGINT_ZERO, fees);
}

export function handlePositionModifiedV2(event: PositionModifiedV2Event): void {
  const v1Params = event.parameters.filter((value) => {
    return value.name !== "skew";
  });

  const v1Event = new PositionModifiedEvent(
    event.address,
    event.logIndex,
    event.transactionLogIndex,
    event.logType,
    event.block,
    event.transaction,
    v1Params,
    event.receipt
  );
  handlePositionModified(v1Event);
}

export function handlePositionLiquidated(event: PositionLiquidatedEvent): void {
  const sdk = SDK.initializeFromEvent(
    conf,
    new Pricer(),
    new TokenInit(),
    event
  );
  const pool = sdk.Pools.loadPool(dataSource.address());
  let sendingAccount = event.params.account;
  let smartMarginAccount = _SmartMarginAccount.load(sendingAccount.toHex());
  const accountAddress = smartMarginAccount
    ? Address.fromBytes(smartMarginAccount.owner)
    : sendingAccount;

  const loadAccountResponse = sdk.Accounts.loadAccount(accountAddress);
  const account = loadAccountResponse.account;
  if (loadAccountResponse.isNewUser) {
    const protocol = sdk.Protocol;
    protocol.addUser();
    pool.addUser();
  }
  const token = sdk.Tokens.getOrCreateToken(NetworkConfigs.getSUSDAddress());

  const position = sdk.Positions.loadPosition(
    pool,
    account,
    token,
    token,
    "",
    null,
    true
  );

  const pnl = position
    .getRealisedPnlUsd()
    .minus(position.position.collateralBalanceUSD);
  account.liquidate(
    pool,
    Address.fromBytes(token.id),
    Address.fromBytes(token.id),
    position.position.collateralBalance,
    event.params.liquidator,
    accountAddress,
    position.getBytesID(),
    pnl
  );
  position.addLiquidationCount();
  position.setBalanceClosed(token, BIGINT_ZERO);
  position.setCollateralBalanceClosed(token, BIGINT_ZERO);
  position.setRealisedPnlUsdClosed(pnl);
}
