// Excerpt, unmodified, of src/services/fee.service.ts (lines 516-524)
// from https://github.com/0base-vc/whoearns-live at commit 52e9b3979f05 — after pull request #68.
// Licensed under MIT by its authors; see corpus/pairs/NOTICE.md.

            const block = await this.fetchBlock(slot, {
              transactionDetails: 'full',
              rewards: true,
              maxSupportedTransactionVersion: 1,
              commitment: 'finalized',
            });
            if (block === null) {
              return { slot, identity, kind: 'skipped' as const };
            }
