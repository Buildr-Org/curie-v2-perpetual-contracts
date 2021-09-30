// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { Tick } from "../lib/Tick.sol";
import { IOrderBook } from "../interface/IOrderBook.sol";

abstract contract OrderBookStorageV1 is IOrderBook {
    address internal exchange;
    address internal quoteToken;

    // first key: trader, second key: base token
    mapping(address => mapping(address => bytes32[])) internal _openOrderIdsMap;

    // key: openOrderId
    mapping(bytes32 => OpenOrder) internal _openOrderMap;

    // first key: base token, second key: tick index
    // value: the accumulator of **Tick.GrowthInfo** outside each tick of each pool
    mapping(address => mapping(int24 => Tick.GrowthInfo)) internal _growthOutsideTickMap;

    // key: base token
    // value: the global accumulator of **quote fee transformed from base fee** of each pool
    mapping(address => uint256) internal _feeGrowthGlobalX128Map;
}
