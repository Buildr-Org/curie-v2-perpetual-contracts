import { waffle } from "hardhat"
import { AccountBalance, BaseToken, ClearingHouse, Exchange, OrderBook } from "../../typechain"
import {
    addOrder,
    closePosition,
    getOrderIds,
    q2bExactInput,
    removeAllOrders,
    removeOrder,
} from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"
import { mintAndDeposit } from "../helper/token"
import { BigNumberish, Wallet } from "ethers"
import { expect } from "chai"
import { parseEther } from "ethers/lib/utils"
import { BigNumber } from "@ethersproject/bignumber"

//docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=1507179977

describe.only("ClearingHouse getPositionSize for taker + maker in xyk pool", () => {
    const wallets = waffle.provider.getWallets()
    const [admin, maker, alice, bob] = wallets
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: ClearingHouse
    let accountBalance: AccountBalance
    let orderBook: OrderBook
    let exchange: Exchange
    let baseToken: BaseToken
    let lowerTick: number
    let upperTick: number

    // taker
    let takerPositionBefore: BigNumberish
    let takerOpenNotionalBefore: BigNumberish
    let orderIdsBefore: string[]
    let orderBefore: { liquidity: BigNumber; lowerTick: number; upperTick: number }

    async function getTakerPositionSize(taker: Wallet, baseToken: BaseToken): Promise<BigNumberish> {
        // TODO rename interface after contact is updated
        return await accountBalance.getPositionSize(taker.address, baseToken.address)
    }

    async function getTakerOpenNotional(taker: Wallet, baseToken: BaseToken): Promise<BigNumberish> {
        // TODO rename interface after contact is updated
        return await exchange.getOpenNotional(taker.address, baseToken.address)
    }

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse
        accountBalance = fixture.accountBalance
        exchange = fixture.exchange
        orderBook = fixture.orderBook
        baseToken = fixture.baseToken

        // prepare market
        const { minTick, maxTick } = await initMarket(fixture, 10, 0, 0)
        lowerTick = minTick
        upperTick = maxTick
    })

    describe("alice takes position, add order within price range then someone else trade", async () => {
        beforeEach(async () => {
            await mintAndDeposit(fixture, maker, 10000)
            await addOrder(fixture, maker, 100, 1000, lowerTick, upperTick)

            // alice: +20b -250q
            // pool: 100/1000 => 80/1250
            await mintAndDeposit(fixture, alice, 1000)
            await q2bExactInput(fixture, alice, 250, baseToken.address)
            takerPositionBefore = await getTakerPositionSize(alice, baseToken)
            takerOpenNotionalBefore = await getTakerOpenNotional(alice, baseToken)

            // alice double the liquidity
            // pool: 80/1250 => 160/2500
            await addOrder(fixture, alice, 80, 1250, lowerTick, upperTick)
            orderIdsBefore = await getOrderIds(fixture, alice)
            orderBefore = await orderBook.getOpenOrderById(orderIdsBefore[0])

            // bob: -40b +500q
            // pool: 160/2500 => 200/2000
            await mintAndDeposit(fixture, bob, 1000)
            await q2bExactInput(fixture, bob, 40, baseToken.address)
        })

        it("won't impact taker's position", async () => {
            expect(await getTakerPositionSize(alice, baseToken)).eq(takerPositionBefore)
            expect(await getTakerOpenNotional(alice, baseToken)).eq(takerOpenNotionalBefore)
        })

        testRemoveAllOrders()
        testRemoveHalfOrder()
        testClosePosition()

        function testRemoveAllOrders() {
            it("remove order will change taker's position", async () => {
                // alice has half shares of the pool, remove her 100% = remove 50% of total pool
                // pool: 200/2000 => 100/1000
                await removeAllOrders(fixture, alice)

                // alice:
                // maker base/quote: -80b, -1250q
                // maker in pool: 100b, 1000q
                // impermanent pos: 20b, -250q
                // taker pos: +20b -250q => +40b, -500q (increase position)
                expect(await getTakerPositionSize(alice, baseToken)).eq(parseEther("40"))
                expect(await getTakerOpenNotional(alice, baseToken)).eq(parseEther("-500"))
            })
        }

        function testRemoveHalfOrder() {
            it("remove 50% order", async () => {
                // alice has half shares of the pool, remove her 50% = remove 25% of total pool
                // pool: 200/2000 => 150/1500
                const halfLiquidity = BigNumber.from(orderBefore.liquidity.toString()).div(2)
                await removeOrder(fixture, alice, halfLiquidity, orderBefore.lowerTick, orderBefore.upperTick)

                // alice:
                // maker base/quote: -80b, -1250q
                // maker in pool: 100b, 1000q
                // impermanent pos: 20b, -250q
                // remove 50% from the pool: 50b, 500q
                // 50% of maker base/quote: -40b, -625q
                // realize pos: 10b, -125q
                // taker pos: +20b -250q => +30b, -375q (increase position)
                expect(await getTakerPositionSize(alice, baseToken)).eq(parseEther("20"))
                expect(await getTakerOpenNotional(alice, baseToken)).eq(parseEther("-375"))
            })
        }

        describe("has 2 order", () => {
            beforeEach(async () => {
                await addOrder(fixture, alice, 80, 1250, lowerTick + 1000, upperTick - 1000)
                const orderIds = await getOrderIds(fixture, alice)
                expect(orderIds.length).gt(1)
            })

            // will has the same result
            testRemoveAllOrders()
            testRemoveHalfOrder()
        })
    })

    describe("alice add order within range, someone trade, then alice take position", async () => {
        beforeEach(async () => {
            await mintAndDeposit(fixture, maker, 10000)
            await addOrder(fixture, maker, 50, 500, lowerTick, upperTick)

            // pool: 50/100 => 1000/1000
            await mintAndDeposit(fixture, alice, 10000)
            await addOrder(fixture, alice, 50, 500, lowerTick, upperTick)
            orderIdsBefore = await getOrderIds(fixture, alice)
            orderBefore = await orderBook.getOpenOrderById(orderIdsBefore[0])

            // bob: +20b -250q
            // pool: 100/1000 => 80/1250
            await mintAndDeposit(fixture, bob, 1000)
            await q2bExactInput(fixture, bob, 250, baseToken.address)

            // alice: +17.5b -350q
            // alice: 80/1250 => 62.5/1600
            await q2bExactInput(fixture, alice, 350, baseToken.address)
            takerPositionBefore = await getTakerPositionSize(alice, baseToken)
            takerOpenNotionalBefore = await getTakerOpenNotional(alice, baseToken)
        })

        it("taker position = exact return from the swap", async () => {
            expect(takerPositionBefore.toString()).eq(parseEther("-17.5"))
            expect(takerOpenNotionalBefore.toString()).eq(parseEther("350"))
        })

        testRemoveAllOrders()
        testRemoveHalfOrder()
        testClosePosition()

        function testRemoveAllOrders() {
            it("remove orders will change taker's position", async () => {
                // alice has half shares of the pool, remove her 100% = remove 50% of total pool
                // pool: 62.5/1600 => 31.25/800
                await removeAllOrders(fixture, alice)

                // alice:
                // maker base/quote: -50b, -500q
                // maker in pool: 31.25b, 800q
                // impermanent pos: -18.75b, 300q
                // taker pos: +17.5b -350q
                // (17.5b -18.75b = opens a larger reverse position)
                // close 17.5b, the positionNotional of the 17.5b from the impermanent pos is 300/18.75*17.5 = 280
                // realizePnl from closing 17.5b = -350 + 280 = -70
                // TODO add expect realizePnl = -70
                // the remaining taker position: 17.5b - 18.75b = -1.25b
                // the remaining open notional: 300q - 280q = 20q
                expect(await getTakerPositionSize(alice, baseToken)).eq(parseEther("-1.25"))
                expect(await getTakerOpenNotional(alice, baseToken)).eq(parseEther("20"))
            })
        }

        function testRemoveHalfOrder() {
            it("remove 50% order", async () => {
                // alice has half shares of the pool, remove her 50% = remove 25% of total pool
                // pool: 62.5/1600 => 46.875/1200
                const halfLiquidity = BigNumber.from(orderBefore.liquidity.toString()).div(2)
                await removeOrder(fixture, alice, halfLiquidity, orderBefore.lowerTick, orderBefore.upperTick)

                // alice:
                // maker base/quote: -50b, -500q
                // maker in pool: 31.25b, 800q
                // impermanent pos: -18.75b, 300q
                // remove 50% from the pool: 15.625b, 400q
                // 50% of maker base/quote: -25b, -250q
                // realize pos: -9.375b, 150q
                // taker pos: +17.5b -350q

                // reduce 9.375b, the openNotional of the 9.375b from the taker pos is 350/17.5*9.375 = 187.5
                // realizePnl from reducing 9.375b = 150 - 187.5 = -37.5
                // TODO add expect realizePnl = -37.5
                // the remaining taker position: 17.5b - 9.375b = 8.125b
                // the remaining open notional: -350/17.5*8.125 = -162.5
                expect(await getTakerPositionSize(alice, baseToken)).eq(parseEther("8.125"))
                expect(await getTakerOpenNotional(alice, baseToken)).eq(parseEther("-162.5"))
            })
        }

        describe("has 2 order", () => {
            beforeEach(async () => {
                await addOrder(fixture, alice, 80, 1250, lowerTick + 1000, upperTick - 1000)
                const orderIds = await getOrderIds(fixture, alice)
                expect(orderIds.length).gt(1)
            })

            // will has the same result
            testRemoveAllOrders()
            testRemoveHalfOrder()
        })
    })

    function testClosePosition() {
        it("won't impact maker's position when closing position", async () => {
            await closePosition(fixture, alice)
            expect(await getTakerPositionSize(alice, baseToken)).eq(0)
            expect(await getTakerPositionSize(alice, baseToken)).eq(0)
            expect(await getOrderIds(fixture, alice)).eq(orderIdsBefore)
        })
    }
})
