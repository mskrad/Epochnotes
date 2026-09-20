// Excerpt, unmodified, of solana/indexer/common/transaction.go (lines 28-42)
// from https://github.com/AudiusProject/api at commit 53f7da590c9a — after pull request #1040.
// Licensed under Apache-2.0 by its authors; see corpus/pairs/NOTICE.md.

	// If the transaction is not in the cache, fetch it from the RPC
	res, err := WithRetriesResult(func() (*rpc.GetTransactionResult, error) {
		return rpcClient.GetTransaction(
			ctx,
			signature,
			&rpc.GetTransactionOpts{
				Commitment:                     rpc.CommitmentConfirmed,
				MaxSupportedTransactionVersion: &rpc.MaxSupportedTransactionVersion1,
			},
		)
	}, 5, 1*time.Second)
	if err != nil {
		return nil, fmt.Errorf("failed to get transaction: %w", err)
	}

