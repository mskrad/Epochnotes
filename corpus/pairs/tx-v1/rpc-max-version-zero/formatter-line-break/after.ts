// Written to reproduce a reported miss (not found in the field): the value sits on the line after the colon,
// as hand-wrapped code or a formatter with a short line width leaves it.
export async function read(connection: Connection, signature: string) {
  return connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion:
      1,
  });
}
