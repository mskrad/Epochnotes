// Written for the corpus: the parameter is left out, which the RPC treats like the lowest version.
export const read = (connection: Connection, signature: string) =>
  connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 1 });
