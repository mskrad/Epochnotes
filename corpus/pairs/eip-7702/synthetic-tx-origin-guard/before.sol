// Written for this corpus: a reentrancy guard that trusts tx.origin, the style EIP-7702 names as broken.
pragma solidity ^0.8.24;

contract Vault {
    mapping(address => uint256) public balance;

    function withdraw(uint256 amount) external {
        require(tx.origin == msg.sender, "no contracts");
        balance[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok);
    }
}
