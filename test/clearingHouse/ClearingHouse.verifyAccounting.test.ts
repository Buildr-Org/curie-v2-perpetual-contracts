import { waffle } from "hardhat"
import { InsuranceFund, Vault } from "../../typechain"
import { mintAndDeposit } from "../helper/token"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"
import {
    addOrder,
    b2qExactInput,
    b2qExactOutput,
    closePosition,
    q2bExactInput,
    q2bExactOutput,
    removeAllOrders,
    removeOrder,
} from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { BigNumber, BigNumberish, Wallet } from "ethers"
import { parseUnits } from "ethers/lib/utils"
import { expect } from "chai"

describe.only("ClearingHouse verify accounting", () => {
    const wallets = waffle.provider.getWallets()
    const [admin, maker, alice, bob] = wallets
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    const uniFeeRatio = 500 // 0.05%
    const exFeeRatio = 1000 // 0.1%
    const ifFeeRatio = 100000 // 10%
    const dustPosSize = 100
    let fixture: ClearingHouseFixture
    let vault: Vault
    let decimals: number
    let insuranceFund: InsuranceFund
    let lowerTick: number
    let upperTick: number
    let baseTokenList: string[]
    let balanceBefore: BigNumberish

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture(true, uniFeeRatio))
        vault = fixture.vault
        decimals = await fixture.USDC.decimals()
        insuranceFund = fixture.insuranceFund

        // mint 1000 to every wallets and store balanceBefore
        for (const wallet of wallets) {
            await mintAndDeposit(fixture, wallet, 1000)
        }
        balanceBefore = parseUnits("1000", decimals).mul(wallets.length)

        // prepare market
        const { minTick, maxTick } = await initMarket(fixture, 10, exFeeRatio, ifFeeRatio)
        lowerTick = minTick
        upperTick = maxTick
        await addOrder(fixture, maker, 100, 1000, lowerTick, upperTick)

        baseTokenList = [fixture.baseToken.address]
    })

    // verify accounting inside afterEach
    // similar to perp-backed repo's analyzer, remove all order and close position except 1 maker
    // settle the last maker by collect fee, close position and remove order.
    // (when everyone has 0 positionSize, their freeCollateral == actual USDC they can withdraw)
    // and the freeCollateral is a number that's already being calculated by realizedPnl
    // expect sum of everyone's freeCollateral == sum of everyone's deposit == usdc.balanceOf(vault)
    afterEach(async () => {
        let balanceAfter = BigNumber.from(0)

        async function updateAfterBalanceByFreeCollateralFrom(trader: string) {
            const freeCollateral = await fixture.vault.getFreeCollateral(trader)
            balanceAfter = balanceAfter.add(freeCollateral)
        }

        async function checkPosSizeEmpty(wallet: Wallet, baseToken: string) {
            expect(await fixture.accountBalance.getPositionSize(wallet.address, baseToken)).be.closeTo(
                BigNumber.from(0),
                dustPosSize,
            )
        }

        // close every trader's position and orders. freeCollateral = collateral after all positions are settled
        const walletsWithoutMaker = wallets.filter(it => it.address !== maker.address)
        for (const baseToken of baseTokenList) {
            for (const wallet of walletsWithoutMaker) {
                await removeAllOrders(fixture, wallet, baseToken)
                await closePosition(fixture, wallet, dustPosSize, baseToken)
                await checkPosSizeEmpty(wallet, baseToken)
            }

            // collect fee
            await removeOrder(fixture, maker, 0, lowerTick, upperTick, baseToken)
            await closePosition(fixture, maker, dustPosSize, baseToken)
            await removeAllOrders(fixture, maker, baseToken)
            await checkPosSizeEmpty(maker, baseToken)
        }

        // sum every wallet's freeBalance to balanceAfter
        for (const wallet of wallets) {
            await updateAfterBalanceByFreeCollateralFrom(wallet.address)
        }

        // calculate insuranceFund's income
        await updateAfterBalanceByFreeCollateralFrom(insuranceFund.address)

        // entire balance should be equal (might have some rounding error, let's assume 0.01)
        expect(balanceBefore).be.closeTo(balanceAfter, 10000)
    })

    describe("single market", async () => {
        await startTest()
    })

    describe.only("two markets", async () => {
        beforeEach(async () => {
            await initMarket(
                fixture,
                10,
                exFeeRatio,
                ifFeeRatio,
                fixture.baseToken2.address,
                fixture.mockedBaseAggregator2,
            )
            await addOrder(fixture, maker, 100, 1000, lowerTick, upperTick, fixture.baseToken2.address)
            baseTokenList.push(fixture.baseToken2.address)
        })

        await startTest()
    })

    async function startTest() {
        describe("one trade", () => {
            it("q2bExactOutput", async () => {
                await q2bExactOutput(fixture, alice, 1)
            })

            it("q2bExactInput", async () => {
                await q2bExactInput(fixture, alice, 100)
            })

            it("b2qExactOutput", async () => {
                await b2qExactOutput(fixture, alice, 100)
            })

            it("b2qExactInput", async () => {
                await b2qExactInput(fixture, alice, 1)
            })
        })

        it("takerTradeWithOnlyOneMaker", async () => {
            // alice
            await q2bExactOutput(fixture, alice, 1)

            // bob
            await b2qExactOutput(fixture, bob, 100)

            // carol
            await b2qExactInput(fixture, bob, 1)
        })

        it("takerAddLiquidityWhileHavingPosition", async () => {
            // alice take position
            await q2bExactInput(fixture, alice, 100)

            // bob take position, bob profit++
            await q2bExactInput(fixture, bob, 100)

            // alice
            await addOrder(fixture, alice, 1, 100, lowerTick, upperTick)
            await removeOrder(fixture, alice, 0, lowerTick, upperTick)
            await closePosition(fixture, alice)

            // bob
            await closePosition(fixture, bob)
        })

        it("makerOpenPosition", async () => {
            // alice
            await addOrder(fixture, alice, 1, 100, lowerTick, upperTick)
            await q2bExactInput(fixture, alice, 100)

            // bob take position, bob profit++
            await q2bExactInput(fixture, bob, 100)
        })
    }
})
