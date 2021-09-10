import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { BaseToken, Exchange, QuoteToken, TestClearingHouse, TestERC20, UniswapV3Pool, Vault } from "../../typechain"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse openPosition", () => {
    const [admin, maker, taker, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let exchange: Exchange
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let baseToken2: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let pool2: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let collateralDecimals: number
    const lowerTick: number = 0
    const upperTick: number = 100000

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        vault = _clearingHouseFixture.vault
        exchange = _clearingHouseFixture.exchange
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        baseToken2 = _clearingHouseFixture.baseToken2
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        pool2 = _clearingHouseFixture.pool2
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)
        // the initial number of oracle can be recorded is 1; thus, have to expand it
        await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

        await pool2.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)
        // add pool after it's initialized
        await exchange.addPool(baseToken.address, 10000)
        await exchange.addPool(baseToken2.address, 10000)
        await exchange.setFeeRatio(baseToken.address, 10000)
        await exchange.setFeeRatio(baseToken2.address, 10000)

        // prepare collateral for maker
        const makerCollateralAmount = parseUnits("1000000", collateralDecimals)
        await collateral.mint(maker.address, makerCollateralAmount)
        await deposit(maker, vault, 1000000, collateral)

        // maker add liquidity
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("65.943787"),
            quote: parseEther("10000"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        // maker
        //   pool.base = 65.9437860798
        //   pool.quote = 10000
        //   liquidity = 884.6906588359
        //   virtual base liquidity = 884.6906588359 / sqrt(151.373306858723226652) = 71.9062751863
        //   virtual quote liquidity = 884.6906588359 * sqrt(151.373306858723226652) = 10884.6906588362

        // prepare collateral for taker
        const takerCollateral = parseUnits("1000", collateralDecimals)
        await collateral.mint(taker.address, takerCollateral)
        await collateral.connect(taker).approve(clearingHouse.address, takerCollateral)
    })

    async function getMakerFee(): Promise<BigNumber> {
        return (
            await clearingHouse.connect(maker).callStatic.removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: lowerTick,
                upperTick: upperTick,
                liquidity: 0,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })
        ).fee
    }

    describe("invalid input", () => {
        describe("taker has enough collateral", () => {
            beforeEach(async () => {
                await deposit(taker, vault, 1000, collateral)
            })

            it("force error due to invalid baseToken", async () => {
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: pool.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: 1,
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                ).to.be.revertedWith("CH_BTNE")
            })

            it("force error due to invalid amount (0)", async () => {
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: 0,
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                ).to.be.revertedWith("UB_ZI")
            })

            it("force error due to slippage protection", async () => {
                // taker want to get 1 vETH in exact current price which is not possible
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: false,
                        oppositeAmountBound: 0,
                        amount: 1,
                        sqrtPriceLimitX96: encodePriceSqrt("151.373306858723226652", "1"),
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                ).to.be.revertedWith("SPL")
            })

            it("force error due to not enough liquidity", async () => {
                // empty the liquidity
                const order = await exchange.getOpenOrder(maker.address, baseToken.address, lowerTick, upperTick)
                await clearingHouse.connect(maker).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick,
                    upperTick,
                    liquidity: order.liquidity,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })

                // trade
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: false,
                        oppositeAmountBound: 0,
                        amount: 1,
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                ).to.be.revertedWith("CH_F0S")
            })
        })
    })

    describe("taker has 0 collateral", () => {
        // using formula: https://www.notion.so/perp/Index-price-spread-attack-2f203d45b34f4cc3ab80ac835247030f#d3d12da52d4c455999dcca491a1ba34d
        const calcQuoteAmountForLong = (marketPrice: number, indexPrice: number, liquidity: number): number => {
            return (indexPrice * liquidity * 0.9 - marketPrice * liquidity) / Math.sqrt(marketPrice) / 10 ** 18 - 1
        }
        // using formula: https://www.notion.so/perp/Index-price-spread-attack-2f203d45b34f4cc3ab80ac835247030f#a14db12f09404b0bb43242be5a706179
        const calcQuoteAmountForShort = (marketPrice: number, indexPrice: number, liquidity: number): number => {
            return (
                (0.9 * marketPrice * liquidity - indexPrice * liquidity) / (0.9 * Math.sqrt(marketPrice)) / 10 ** 18 - 1
            )
        }
        beforeEach(async () => {
            // set fee ratio to 0
            await exchange.setFeeRatio(baseToken.address, 0)
        })
        describe("market price lesser than index price", () => {
            beforeEach(async () => {
                // the index price must be larger than (market price / 0.9) = 151 / 0.9 ~= 167
                // market price = 151.373306858723226652
                // index price = 170
                // liquidity = 884690658835870366575
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("170", 6), 0, 0, 0]
                })
            })
            it("force error, Q2B, due to not enough collateral for mint", async () => {
                const quoteAmount = calcQuoteAmountForLong(
                    151.373306858723226652,
                    170,
                    884690658835870366575,
                ).toString()
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: parseEther(quoteAmount),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                ).to.be.revertedWith("CH_NEAV")
            })

            it("force error, B2Q, due to not enough collateral for mint", async () => {
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: false,
                        oppositeAmountBound: 0,
                        amount: parseEther("100"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                ).to.be.revertedWith("CH_NEAV")
            })
        })

        describe("market price larger than index price", () => {
            beforeEach(async () => {
                // the index price must be lesser than (market price * 0.9) = 151 * 0.9 ~= 135.9
                // market price = 151.373306858723226652
                // index price = 133
                // liquidity = 884690658835870366575
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("133", 6), 0, 0, 0]
                })
            })
            it("force error, Q2B, due to not enough collateral for mint", async () => {
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: parseEther("100"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                ).to.be.revertedWith("CH_NEAV")
            })

            it("force error, B2Q, due to not enough collateral for mint", async () => {
                const quoteAmount = calcQuoteAmountForShort(
                    151.373306858723226652,
                    133,
                    884690658835870366575,
                ).toString()
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: false,
                        oppositeAmountBound: 0,
                        amount: parseEther(quoteAmount),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                ).to.be.revertedWith("CH_NEAV")
            })
        })
    })

    describe("taker open position from zero", async () => {
        beforeEach(async () => {
            await deposit(taker, vault, 1000, collateral)
        })

        describe("long", () => {
            it("verify base and quote amount in static call", async () => {
                // taker swap 1 USD for 6539527905092835/10^18 ETH
                const response = await clearingHouse.connect(taker).callStatic.openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
                expect(response.deltaBase).to.be.eq("6539527905092835")
                expect(response.deltaQuote).to.be.eq("1000000000000000000")
            })

            it("increase ? position when exact input", async () => {
                // taker swap 1 USD for ? ETH
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                )
                    .to.emit(clearingHouse, "PositionChanged")
                    .withArgs(
                        taker.address, // trader
                        baseToken.address, // baseToken
                        "6539527905092835", // exchangedPositionSize
                        parseEther("-0.99"), // exchangedPositionNotional
                        parseEther("0.01"), // fee = 1 * 0.01
                        parseEther("-1"), // openNotional
                        parseEther("0"), // realizedPnl
                    )
                const [baseTokenInfo] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const [, quoteTokenInfo] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                expect(baseTokenInfo.balance).be.gt(parseEther("0"))
                expect(quoteTokenInfo.balance).be.deep.eq(parseEther("-1"))

                expect(await getMakerFee()).be.closeTo(parseEther("0.01"), 1)
            })

            it("increase 1 long position when exact output", async () => {
                // taker swap ? USD for 1 ETH -> quote to base -> fee is charged before swapping
                //   exchanged notional = 71.9062751863 * 10884.6906588362 / (71.9062751863 - 1) - 10884.6906588362 = 153.508143394
                //   taker fee = 153.508143394 / 0.99 * 0.01 = 1.550587307

                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: false,
                        oppositeAmountBound: 0,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                )
                    .to.emit(clearingHouse, "PositionChanged")
                    .withArgs(
                        taker.address, // trader
                        baseToken.address, // baseToken
                        parseEther("1"), // exchangedPositionSize
                        "-153508143394151325059", // exchangedPositionNotional
                        "1550587307011629547", // fee
                        "-155058730701162954606", // openNotional
                        parseEther("0"), // realizedPnl
                    )

                const [baseTokenInfo] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const [, quoteTokenInfo] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                expect(baseTokenInfo.balance).be.deep.eq(parseEther("1"))
                expect(quoteTokenInfo.balance).be.lt(parseEther("0"))

                expect(await getMakerFee()).be.closeTo(parseEther("1.550587307011629547"), 1)
            })
        })
        describe("short", () => {
            it("increase position from 0, exact input", async () => {
                // taker swap 1 ETH for ? USD -> base to quote -> fee is included in exchangedNotional
                //   taker exchangedNotional = 10884.6906588362 - 71.9062751863 * 10884.6906588362 / (71.9062751863 + 1) = 149.2970341856
                //   taker fee = 149.2970341856 * 0.01 = 1.492970341856

                // taker swap 1 ETH for ? USD
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                )
                    .to.emit(clearingHouse, "PositionChanged")
                    .withArgs(
                        taker.address, // trader
                        baseToken.address, // baseToken
                        parseEther("-1"), // exchangedPositionSize
                        parseEther("149.297034185732877727"), // exchangedPositionNotional
                        parseEther("1.492970341857328778"), // fee: 149.297034185732877727 * 0.01 = 1.492970341857328777
                        parseEther("147.804063843875548949"), // openNotional
                        parseEther("0"), // realizedPnl
                    )
                const [baseTokenInfo] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const [, quoteTokenInfo] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)

                expect(baseTokenInfo.balance).be.deep.eq(parseEther("-1"))
                expect(quoteTokenInfo.balance).be.gt(parseEther("0"))

                expect(await getMakerFee()).be.closeTo(parseEther("1.492970341857328777"), 1)
            })

            it("increase position from 0, exact output", async () => {
                // taker swap ? ETH for 1 USD -> base to quote -> fee is included in exchangedNotional
                //   taker exchangedNotional = 71.9062751863 - 71.9062751863 * 10884.6906588362 / (10884.6906588362 - 1)
                //                           = -0.006606791523
                //   taker fee = 1 / (0.99) * 0.01 = 0.0101010101

                // taker swap ? ETH for 1 USD
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: false,
                        oppositeAmountBound: 0,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                )
                    .to.emit(clearingHouse, "PositionChanged")
                    .withArgs(
                        taker.address, // trader
                        baseToken.address, // baseToken
                        parseEther("-0.006673532984759078"), // exchangedPositionSize
                        parseEther("1.010101010101010102"), // exchangedPositionNotional
                        parseEther("0.010101010101010102"), // fee
                        parseEther("1"), // openNotional
                        parseEther("0"), // realizedPnl
                    )

                const [baseTokenInfo] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const [, quoteTokenInfo] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                expect(baseTokenInfo.balance).be.lt(parseEther("0"))
                expect(quoteTokenInfo.balance).be.deep.eq(parseEther("1"))

                expect(await getMakerFee()).be.closeTo(parseEther("0.010101010101010102"), 1)
            })
        })
    })

    describe("opening long first then", () => {
        beforeEach(async () => {
            await deposit(taker, vault, 1000, collateral)

            // 71.9062751863 - 884.6906588359 ^ 2  / (10884.6906588362 + 2 * 0.99) = 0.01307786649
            // taker swap 2 USD for 0.01307786649 ETH
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("2"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // virtual base liquidity = 71.9062751863 - 0.01307786649 = 71.8931973198
            // virtual quote liquidity = 10884.6906588362 + 2 * 0.99 = 10886.6706588362
        })

        it("increase position", async () => {
            const [baseTokenInfoBefore] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
            const [, quoteTokenInfoBefore] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)

            // taker swap 1 USD for ? ETH again
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // increase ? USD debt, increase 1 ETH available, the rest remains the same
            const [baseTokenInfoAfter] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
            const [, quoteTokenInfoAfter] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
            const baseBalanceDelta = baseTokenInfoAfter.balance.sub(baseTokenInfoBefore.balance)
            const quoteBalanceDelta = quoteTokenInfoAfter.balance.sub(quoteTokenInfoBefore.balance)
            expect(baseBalanceDelta).be.gt(parseEther("0"))
            expect(quoteBalanceDelta).be.deep.eq(parseEther("-1"))

            // pos size: 0.01961501593
            expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).to.eq("19615015933642630")
            expect(await clearingHouse.getNetQuoteBalance(taker.address)).to.eq(parseEther("-3"))

            // (2 (beforeEach) + 1 (now)) * 1% = 0.03
            expect(await getMakerFee()).be.closeTo(parseEther("0.03"), 1)
        })

        it("reduce position", async () => {
            const [baseTokenInfoBefore] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
            const [, quoteTokenInfoBefore] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)

            // reduced base = 0.006538933220746360
            const reducedBase = baseTokenInfoBefore.balance.div(2)
            // taker reduce 50% ETH position for ? USD
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: reducedBase,
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // increase ? USD available, reduce 1 ETH available, the rest remains the same
            const [baseTokenInfoAfter] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
            const [, quoteTokenInfoAfter] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
            const baseBalanceDelta = baseTokenInfoAfter.balance.sub(baseTokenInfoBefore.balance)
            const quoteBalanceDelta = quoteTokenInfoAfter.balance.sub(quoteTokenInfoBefore.balance)
            expect(baseBalanceDelta).be.deep.eq(-reducedBase)
            expect(quoteBalanceDelta).be.gt(parseEther("0"))

            // pos size: 0.006538933220746361
            expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).to.eq("6538933220746361")
            expect(await clearingHouse.getNetQuoteBalance(taker.address)).to.eq(quoteTokenInfoAfter.balance)
        })

        it("close position, base's available/debt will be 0, settle to owedRealizedPnl", async () => {
            // expect taker has 2 USD worth ETH
            const [baseTokenInfo] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
            const posSize = baseTokenInfo.balance
            // posSize = 0.013077866441492721

            // taker sells 0.013077866441492721 ETH
            // CH will boost the ETH amount in, but then pool will cut the exact percentage as fee,
            //   so the actual swapped in amount is still 0.013077866441492721
            //   amount out would be:
            //     10886.6706588362 - 884.6906588359 ^ 2 / (71.8931973198 + 0.013077866441492721) = 1.98000000000026751159
            // taker gets 1.98000000000026751159 * 0.99 = 1.9602000000002648364741
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: posSize,
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // base balance will be 0
            {
                const [baseTokenInfo] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const [, quoteTokenInfo] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                expect(baseTokenInfo.balance).be.deep.eq(parseEther("0"))
                expect(quoteTokenInfo.balance).be.deep.eq(parseEther("0"))

                // 2 - 1.9602000000002648364741 = 0.0398000015
                const pnl = await clearingHouse.getOwedRealizedPnl(taker.address)
                expect(pnl).eq(parseEther("-0.039800000000000043")) // fee loss
            }

            // free collateral will be less than original number bcs of fees
            // 1000 - 0.039800000000000043 = 999.9602
            const freeCollateral = await vault.getFreeCollateral(taker.address)
            expect(freeCollateral).deep.eq(parseUnits("999.960199", 6))

            expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).to.eq("0")
        })

        it("close position with profit", async () => {
            // expect taker has 2 USD worth ETH
            const [baseTokenInfo] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
            const posSize = baseTokenInfo.balance
            // posSize = 0.013077866441492721

            // prepare collateral for carol
            const carolAmount = parseEther("1000")
            await collateral.connect(admin).mint(carol.address, carolAmount)
            await deposit(carol, vault, 1000, collateral)

            // carol pays $1000 for ETH long
            // 71.8931973198 - 884.6906588359 ^ 2 / (10886.6706588362 + 990) = 5.9927792385
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: carolAmount,
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // virtual base liquidity = 71.8931973198 - 5.9927792385 = 65.9004180813
            // virtual quote liquidity = 10886.6706588362 + 990 = 11876.6706588362

            // CH will boost the ETH amount in, but then pool will cut the exact percentage as fee,
            //   so the actual swapped in amount is still 0.013077866441492721
            //   amount out would be:
            //     11876.6706588362 - 884.6906588359 ^ 2 / (65.9004180813 + 0.013077866441492721) = 2.3564447634
            // taker gets 2.3564447634 * 0.99 = 2.3328803158
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: posSize,
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // mock index price to market price
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("103.12129", 6), 0, 0, 0]
            })

            // base debt and available will be 0
            {
                const [baseTokenInfo] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const [, quoteTokenInfo] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                expect(baseTokenInfo.balance).be.deep.eq(parseEther("0"))
                expect(quoteTokenInfo.balance).be.deep.eq(parseEther("0"))

                // pnl = 2.3328803158 - 2 = 0.3328803158
                const pnl = await clearingHouse.getOwedRealizedPnl(taker.address)
                expect(pnl).deep.eq(parseEther("0.332880320006927809"))
            }

            // collateral will be less than original number bcs of fees
            const freeCollateral = await vault.getFreeCollateral(taker.address)
            expect(freeCollateral).deep.eq(parseUnits("1000.33288", 6))

            expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).to.eq("0")
        })

        it("close position with loss", async () => {
            // expect taker has 2 USD worth ETH
            const [baseTokenInfo] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
            const posSize = baseTokenInfo.balance

            // prepare collateral for carol
            const carolAmount = parseEther("1000")
            await collateral.connect(admin).mint(carol.address, carolAmount)
            await deposit(carol, vault, 1000, collateral)

            // carol pays for $1000 ETH short
            // B2QFee: CH actually gets 1000 / 0.99 = 1010.101010101 quote
            // 884.6906588359 ^ 2 / (10886.6706588362 - 1010.101010101) - 71.8931973198 = 7.3526936796
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: carolAmount,
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // 0.0130787866

            // virtual base liquidity = 71.8931973198 + 7.3526936796 = 79.2458909994
            // virtual quote liquidity = 10886.6706588362 - 1010.101010101 = 9876.5696487352

            // CH will boost the ETH amount in, but then pool will cut the exact percentage as fee,
            //   so the actual swapped in amount is still 0.013077866441492721
            //   amount out would be:
            //     9876.5696487352 - 884.6906588359 ^ 2 / (79.2458909994 + 0.013077866441492721) = 1.6296510132
            // taker gets 1.6296510132 * 0.99 = 1.6133545031
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: posSize,
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // base debt and available will be 0
            {
                const [baseTokenInfo] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const [, quoteTokenInfo] = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                expect(baseTokenInfo.balance).be.deep.eq(parseEther("0"))
                expect(quoteTokenInfo.balance).be.deep.eq(parseEther("0"))

                // pnl = 1.6133545031 -2 = -0.3866454969
                const pnl = await clearingHouse.getOwedRealizedPnl(taker.address)
                expect(pnl).deep.eq(parseEther("-0.386645498819609266"))
            }

            // collateral will be less than original number bcs of fees
            const freeCollateral = await vault.getFreeCollateral(taker.address)
            expect(freeCollateral).deep.eq(parseUnits("999.613354", collateralDecimals))

            expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).to.eq("0")
        })

        it("open larger reverse position", async () => {
            // taker has 2 USD worth ETH long position
            // then opens 10 USD worth ETH short position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("10"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // position size = -0.05368894844
            expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).to.eq("-53688948443543907")

            // openNotional = 8.0412624948
            expect(await clearingHouse.getOpenNotional(taker.address, baseToken.address)).to.eq("8041262494847024252")

            // realizedPnl = -0.04126249485
            expect(await clearingHouse.getOwedRealizedPnl(taker.address)).to.eq("-41262494847024252")
        })

        // TODO: blocked by TWAP based _getDebtValue
        it.skip("force error, can't open another long if it's under collateral", async () => {
            // prepare collateral for carol
            const carolAmount = parseUnits("1000", collateralDecimals)
            await collateral.connect(admin).mint(carol.address, carolAmount)
            await deposit(carol, vault, 1000, collateral)

            // carol open short to make taker under collateral
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: carolAmount,
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // taker want to increase position but he's under collateral
            // TODO expect taker's margin ratio < mmRatio
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: 1,
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.be.revertedWith("CH_CNE")
        })
    })

    describe("opening short first then", () => {
        beforeEach(async () => {
            await deposit(taker, vault, 1000, collateral)
            // taker swap ? ETH for 2 USD
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("2"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
        })
        it("increase position")
        it("reduce position")
        it("close position")

        it("open larger reverse position", async () => {
            // taker has 2 USD worth ETH short position
            // then opens 10 USD worth ETH long position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false, // quote to base
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("10"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).to.eq("52017742202701754")

            // because taker opens a larger reverse position, her position is closed and increase a new one
            // she spent $8 for the 2nd tx, openNotional = -8 - realizedPnlBcsOfFeeFromPrevTx
            const openNotional = await clearingHouse.getOpenNotional(taker.address, baseToken.address)
            const realizedPnl = await clearingHouse.getOwedRealizedPnl(taker.address)
            expect(openNotional).to.eq("-7957914633138379981")
            expect(openNotional).to.eq(parseEther("-8").sub(realizedPnl))
        })
    })

    // https://docs.google.com/spreadsheets/d/1xcWBBcQYwWuWRdlHtNv64tOjrBCnnvj_t1WEJaQv8EY/edit#gid=1258612497
    describe("maker has order out of price range", () => {
        it("will not affect her range order")
    })

    describe("maker has order within price range", () => {
        it("will not affect her range order")
        it("force error if she is going to liquidate herself")
    })

    describe("markets number exceeded", () => {
        beforeEach(async () => {
            await clearingHouse.connect(maker).addLiquidity({
                baseToken: baseToken2.address,
                base: parseEther("65.943787"),
                quote: parseEther("10000"),
                lowerTick,
                upperTick,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            await deposit(taker, vault, 1000, collateral)
            await clearingHouse.setMaxMarketsPerAccount("1")
        })
        it("after closing position on market A, could open on market B ", async () => {
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // close market of baseToken
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken2.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("10"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.emit(clearingHouse, "PositionChanged")
        })

        it("force error, markets number exceeded", async () => {
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.emit(clearingHouse, "PositionChanged")

            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken2.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.be.revertedWith("CH_MNE")
        })
    })
})
