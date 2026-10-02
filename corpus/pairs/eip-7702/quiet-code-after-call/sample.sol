// Written for this corpus: code that reads tx.origin and code length without the assumptions EIP-7702 breaks.
pragma solidity ^0.8.24;

contract Relay {
    event Relayed(address indexed origin, address indexed target);

    function relay(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory returned) = target.call(data);
        // A call to an address without code succeeds and returns nothing: the code is checked after the call.
        require(ok && (returned.length > 0 || target.code.length > 0), "no target");
        emit Relayed(tx.origin, target);
        return returned;
    }
}
