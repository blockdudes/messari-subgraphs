import { TokenPricer, ProtocolConfig } from "../sdk/protocols/config";
import { SDK } from "../sdk/protocols/perpfutures";
import { NetworkConfigs } from "../../configurations/configure";
import { Versions } from "../versions";
import { Token } from "../../generated/schema";
import { _ERC20 } from "../../generated/FuturesMarketManager1/_ERC20";
import {
  Address,
  BigDecimal,
  BigInt,
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
import { LiquidityPoolFeeType } from "../sdk/util/constants";
import { MarketAdded as MarketAddedEvent } from "../../generated/FuturesMarketManager1/FuturesMarketManager";

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
    const token = sdk.Tokens.getOrCreateToken(dataSource.address());
    pool.initialize(marketKey, marketKey, [token], token, "chainlink");

    pool.setPoolFee(
      LiquidityPoolFeeType.DYNAMIC_PROTOCOL_FEE,
      safeDivide(
        BigInt.fromI32(6).toBigDecimal(),
        BigInt.fromI32(100).toBigDecimal()
      )
    );
    pool.setPoolFee(
      LiquidityPoolFeeType.DYNAMIC_LP_FEE,
      safeDivide(
        BigInt.fromI32(6).toBigDecimal(),
        BigInt.fromI32(100).toBigDecimal()
      )
    );
  }

  // // create market cumulative stats
  // let marketStats = getOrCreateMarketCumulativeStats(event.params.marketKey.toHex());
  // marketStats.save();
  // marketEntity.marketStats = marketStats.id;
  // marketEntity.save();

  // check that it's a v1 market before adding
  if (marketKey.startsWith("s") && !marketKey.endsWith("PERP")) {
    log.info("New V1 market added: {}", [marketKey]);

    // futures v1 market
    // FuturesV1Market.create(event.params.market);
  }
}

// export function handleV1MarketAdded(event: MarketAddedEvent): void {
//   const caller = event.params.sender;
//   const depositAmount = event.params.assets;
//   const mintAmount = event.params.shares;

//   const sdk = SDK.initializeFromEvent(
//     conf,
//     new Pricer(),
//     new TokenInit(),
//     event
//   );

//   const depositToken = sdk.Tokens.getOrCreateToken(
//     NetworkConfigs.getDaiAddress()
//   );
//   const outputToken = sdk.Tokens.getOrCreateToken(dataSource.address());

//   const pool = sdk.Pools.loadPool(dataSource.address());
//   if (!pool.isInitialized) {
//     pool.initialize(
//       "gDAI Vault",
//       "gDAI Vault",
//       [depositToken],
//       outputToken,
//       "chainlink"
//     );

//     pool.setPoolFee(
//       LiquidityPoolFeeType.DYNAMIC_PROTOCOL_FEE,
//       safeDivide(
//         BigInt.fromI32(6).toBigDecimal(),
//         BigInt.fromI32(100).toBigDecimal()
//       )
//     );
//     pool.setPoolFee(
//       LiquidityPoolFeeType.DYNAMIC_LP_FEE,
//       safeDivide(
//         BigInt.fromI32(6).toBigDecimal(),
//         BigInt.fromI32(100).toBigDecimal()
//       )
//     );
//   }
//   pool.addOutputTokenSupply(mintAmount);

//   const depositAmounts = createTokenAmountArray(
//     pool,
//     [depositToken],
//     [depositAmount]
//   );
//   const loadAccountResponse = sdk.Accounts.loadAccount(caller);
//   const account = loadAccountResponse.account;
//   if (loadAccountResponse.isNewUser) {
//     const protocol = sdk.Protocol;
//     protocol.addUser();
//     pool.addUser();
//   }

//   account.deposit(pool, depositAmounts, mintAmount);
//   pool.addInputTokenBalances(depositAmounts);
// }
