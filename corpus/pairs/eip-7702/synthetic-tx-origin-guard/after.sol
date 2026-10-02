// Written for this corpus: the same withdrawal behind a transient-storage reentrancy guard.
pragma solidity ^0.8.24;

contract Vault {
    mapping(address => uint256) public balance;
    bool transient entered;

    function withdraw(uint256 amount) external {
        require(!entered, "reentrant");
        entered = true;
        balance[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok);
        entered = false;
    }
}
