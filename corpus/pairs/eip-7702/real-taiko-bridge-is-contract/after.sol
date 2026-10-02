// Excerpt, unmodified, of packages/protocol/contracts/shared/bridge/Bridge.sol (lines 581-595)
// from https://github.com/taikoxyz/taiko-mono at commit 798c9f868bfb — after pull request #20939.
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
            && bytes4(_message.data) != IMessageInvocable.onMessageInvocation.selector;
    }
