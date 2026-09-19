// A formatter broke the line after the colon: the value sits on the next line.
export async function read(connection: Connection, signature: string) {
  return connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion:
      1,
  });
}
