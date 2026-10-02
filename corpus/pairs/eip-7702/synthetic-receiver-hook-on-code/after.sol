// Written for this corpus: the hook is skipped for a delegated EOA, told apart by its delegation indicator.
pragma solidity ^0.8.24;

import {EIP7702Utils} from "@openzeppelin/contracts/account/utils/EIP7702Utils.sol";

interface IReceiver {
    function onReceived(address from, uint256 id) external returns (bytes4);
}

library Delivery {
    function notify(address to, address from, uint256 id) internal {
        bool deployed = to.code.length != 0 && EIP7702Utils.fetchDelegate(to) == address(0);
        if (deployed) {
            require(IReceiver(to).onReceived(from, id) == IReceiver.onReceived.selector, "rejected");
        }
    }
}
