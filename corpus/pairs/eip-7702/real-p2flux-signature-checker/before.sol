// Excerpt, unmodified, of contracts/P2FluxRecurring.sol (lines 228-242)
// from https://github.com/P2Flux/contracts at commit 11716cca0875 — before the fix.
// Licensed under MIT by its authors; see corpus/pairs/NOTICE.md.

        if (auth.period == 0) revert ZeroPeriod();
        if (auth.end != 0 && auth.end <= auth.start) revert InvalidEnd();
        if (block.timestamp < auth.start) revert NotStarted();
        if (auth.end != 0 && block.timestamp >= auth.end) revert Expired();

        bytes32 id = subscriptionId(auth);
        if (revoked[id]) revert Revoked();

        // The customer's signature over these exact terms, verified here, every time.
        // SignatureChecker also accepts ERC-1271 signatures from contract wallets.
        if (!SignatureChecker.isValidSignatureNow(auth.payer, id, signature)) revert InvalidSignature();

        uint256 periodIndex = (block.timestamp - auth.start) / auth.period;
        if (lastChargedPeriodPlusOne[id] >= periodIndex + 1) revert AlreadyChargedThisPeriod();

