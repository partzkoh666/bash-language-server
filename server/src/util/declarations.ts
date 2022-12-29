import * as LSP from 'vscode-languageserver/node'
import * as Parser from 'web-tree-sitter'

import * as TreeSitterUtil from './tree-sitter'

const TREE_SITTER_TYPE_TO_LSP_KIND: { [type: string]: LSP.SymbolKind | undefined } = {
  // These keys are using underscores as that's the naming convention in tree-sitter.
  environment_variable_assignment: LSP.SymbolKind.Variable,
  function_definition: LSP.SymbolKind.Function,
  variable_assignment: LSP.SymbolKind.Variable,
}

export type Declarations = { [word: string]: LSP.SymbolInformation[] }

/**
 * Returns declarations (functions or variables) from a given root node
 * that would be available after sourcing the file.
 *
 * Will only return one declaration per symbol name – the latest definition.
 * This behavior is consistent with how Bash behaves, but differs between
 * LSP servers.
 *
 * Used when finding declarations for sourced files and to get declarations
 * for the entire workspace.
 */
export function getGlobalDeclarations({
  tree,
  uri,
}: {
  tree: Parser.Tree
  uri: string
}): { diagnostics: LSP.Diagnostic[]; declarations: Declarations } {
  const diagnostics: LSP.Diagnostic[] = []
  const declarations: Declarations = {}

  TreeSitterUtil.forEach(tree.rootNode, (node: Parser.SyntaxNode) => {
    if (node.parent?.type !== 'program') {
      return
    }

    if (node.type === 'ERROR') {
      diagnostics.push(
        LSP.Diagnostic.create(
          TreeSitterUtil.range(node),
          'Failed to parse',
          LSP.DiagnosticSeverity.Error,
        ),
      )
      return
    }

    if (TreeSitterUtil.isDefinition(node)) {
      const symbol = nodeToSymbolInformation({ node, uri })

      if (symbol) {
        const word = symbol.name
        declarations[word] = [symbol] // TODO: ensure this is the latest definition
      }
    }

    return
  })

  return { diagnostics, declarations }
}

function nodeToSymbolInformation({
  node,
  uri,
}: {
  node: Parser.SyntaxNode
  uri: string
}): LSP.SymbolInformation | null {
  const named = node.firstNamedChild

  if (named === null) {
    return null
  }

  const containerName =
    TreeSitterUtil.findParent(node, (p) => p.type === 'function_definition')
      ?.firstNamedChild?.text || ''

  const kind = TREE_SITTER_TYPE_TO_LSP_KIND[node.type]

  return LSP.SymbolInformation.create(
    named.text,
    kind || LSP.SymbolKind.Variable,
    TreeSitterUtil.range(node),
    uri,
    containerName,
  )
}

/**
 * Returns declarations available for the given file and location
 * Done by traversing the tree upwards (which is a simplification for
 * actual bash behaviour but deemed good enough, compared to the complexity of flow tracing).
 * Filters out duplicate definitions. Used when getting declarations for the current scope.
 */
export function getLocalDeclarations({
  node,
  uri,
}: {
  node: Parser.SyntaxNode | null
  uri: string
}): Declarations {
  const declarations: Declarations = {}

  // bottom up traversal of the tree to capture all local declarations

  const walk = (node: Parser.SyntaxNode | null) => {
    // NOTE: there is also node.walk
    if (node) {
      for (const childNode of node.children) {
        let symbol: LSP.SymbolInformation | null = null

        // local variables
        if (childNode.type === 'declaration_command') {
          const variableAssignmentNode = childNode.children.filter(
            (child) => child.type === 'variable_assignment',
          )[0]

          if (variableAssignmentNode) {
            symbol = nodeToSymbolInformation({
              node: variableAssignmentNode,
              uri,
            })
          }
        } else if (TreeSitterUtil.isDefinition(childNode)) {
          // FIXME: does this also capture local variables?
          symbol = nodeToSymbolInformation({ node: childNode, uri })
        }

        if (symbol) {
          if (!declarations[symbol.name]) {
            declarations[symbol.name] = []
          }
          declarations[symbol.name].push(symbol)
        }
      }

      walk(node.parent)
    }
  }

  walk(node)

  return declarations
}
