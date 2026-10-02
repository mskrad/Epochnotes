// Written for this corpus: a receiver hook called on every recipient with code, as OpenZeppelin's ERC721Utils
// does; a delegated EOA now gets the call.
pragma solidity ^0.8.24;

interface IReceiver {
    function onReceived(address from, uint256 id) external returns (bytes4);
}

library Delivery {
    function notify(address to, address from, uint256 id) internal {
        if (to.code.length > 0) {
            require(IReceiver(to).onReceived(from, id) == IReceiver.onReceived.selector, "rejected");
        }
    }
}
