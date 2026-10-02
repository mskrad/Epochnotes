// Written for this corpus: the same assumption spelled in assembly.
pragma solidity ^0.8.24;

library Accounts {
    function isEOA(address account) internal view returns (bool result) {
        assembly {
            result := iszero(extcodesize(account))
        }
    }
}
