// Written for this corpus: code next to what the rules read, without the assumptions EIP-7702 breaks.
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

    // Declaring the helper is not calling it: the rule on isContract calls must stay silent here.
    function isContract(address account) internal view returns (bool) {
        return account.code.length > 0;
    }

    function codeSize(address account) internal view returns (uint256) {
        return account.code.length + 0;
    }
}
