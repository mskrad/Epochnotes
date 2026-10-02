// Written for this corpus: an account is told apart by its delegation indicator, read explicitly.
pragma solidity ^0.8.24;

import {EIP7702Utils} from "@openzeppelin/contracts/account/utils/EIP7702Utils.sol";

library Accounts {
    function delegateOf(address account) internal view returns (address) {
        return EIP7702Utils.fetchDelegate(account);
    }
}
