// Excerpt, unmodified, of packages/protocol/contracts/shared/bridge/Bridge.sol (lines 584-599)
// from https://github.com/taikoxyz/taiko-mono at commit 546351e428de — before pull request #20939.
// Licensed under MIT by its authors; see corpus/pairs/NOTICE.md.

    function _unableToInvokeMessageCall(
        Message calldata _message,
        ISignalService _signalService
    )
        private
        view
        returns (bool)
    {
        if (_message.to == address(0)) return true;
        if (_message.to == address(this)) return true;
        if (_message.to == address(_signalService)) return true;

        return _message.data.length >= 4
            && bytes4(_message.data) != IMessageInvocable.onMessageInvocation.selector
            && _message.to.isContract();
    }
