// Excerpt, unmodified, of packages/gasstation/src/client.ts (lines 644-654)
// from https://github.com/AltudePlatform/altude-js at commit 294662fb078e — after pull request #73.
// Licensed under MIT by its authors; see corpus/pairs/NOTICE.md.

      offset,
      total: signatures.length,
    }
    for (const sig of signatureList) {
      const transaction = await client.rpc
        .getTransaction(sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 })
        .send()
      if (!transaction) continue
      try {
        transactionlist.data.push(this.summarizeTransaction(transaction  as GetTransactionApiResponseBase, sig, walletAddr))
      } catch (err) {
