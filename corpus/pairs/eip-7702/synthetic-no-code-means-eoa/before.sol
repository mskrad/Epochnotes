// Written for this corpus: an account without code is taken for an EOA, in both orders of the comparison.
pragma solidity ^0.8.24;

library Accounts {
    function isEOA(address account) internal view returns (bool) {
        return account.code.length == 0;
    }

    function isPerson(address account) internal view returns (bool) {
        return 0 == account.code.length;
    }
}
