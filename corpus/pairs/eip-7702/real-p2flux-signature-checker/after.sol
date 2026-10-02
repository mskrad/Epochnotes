// Excerpt, unmodified, of contracts/P2FluxRecurring.sol (lines 248-260)
// from https://github.com/P2Flux/contracts at commit a41e1c7b0dbe — after the fix.
// Licensed under MIT by its authors; see corpus/pairs/NOTICE.md.

        if (auth.end != 0 && auth.end <= auth.start) revert InvalidEnd();
        if (block.timestamp < auth.start) revert NotStarted();
        if (auth.end != 0 && block.timestamp >= auth.end) revert Expired();

        bytes32 id = subscriptionId(auth);
        if (revoked[id]) revert Revoked();

        // The customer's authorization over these exact terms, verified here, every time.
        if (!_isAuthorized(auth.payer, id, signature)) revert InvalidSignature();

        uint256 periodIndex = (block.timestamp - auth.start) / auth.period;
        if (lastChargedPeriodPlusOne[id] >= periodIndex + 1) revert AlreadyChargedThisPeriod();

