import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const index = new URL('../src/index.ts', import.meta.url).pathname;

function undocumentedExports(): string[] {
  const program = ts.createProgram([index], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(index);
  const module = source === undefined ? undefined : checker.getSymbolAtLocation(source);
  if (module === undefined) throw new Error(`${index} did not load`);
  return checker
    .getExportsOfModule(module)
    .filter((symbol) => {
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      return target.getDocumentationComment(checker).length === 0;
    })
    .map((symbol) => symbol.name);
}

describe('the public API of the core package', () => {
  it('documents every export, because its JSDoc is what users of the npm package read in their editor', () => {
    expect(undocumentedExports()).toEqual([]);
  }, 30_000);
});
