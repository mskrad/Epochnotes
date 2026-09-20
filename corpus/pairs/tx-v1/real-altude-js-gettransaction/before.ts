// Excerpt, unmodified, of packages/gasstation/src/client.ts (lines 636-646)
// from https://github.com/AltudePlatform/altude-js at commit 0547ba0cc104 — before pull request #73.
// Licensed under MIT by its authors; see corpus/pairs/NOTICE.md.

      offset,
      total: signatures.length,
    }
    for (const sig of signatureList) {
      const transaction = await client.rpc
        .getTransaction(sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
        .send()
      if (!transaction) continue
      try {
        transactionlist.data.push(this.summarizeTransaction(transaction  as GetTransactionApiResponseBase, sig, walletAddr))
      } catch (err) {
