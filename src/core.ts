import {
    DefinitionNode,
    DocumentNode,
    FieldNode,
    Kind,
    OperationDefinitionNode,
    parse,
    print,
    SelectionSetNode,
    separateOperations,
} from 'graphql';
import { SelectionNode } from 'graphql/language/ast';
import { ExtractGQL } from 'persistgraphql/lib/src/ExtractGQL';
import HasuraApi from './hasura';

const INTERPOLATION_REGEX = /\${([\s\S]+?)}/gm;

// TODO Most of this implementation has been copped from here:
// https://github.com/apollostack/apollo-client/blob/master/src/queries/queryTransform.ts
//
// This probably means that this implementation should be exported as some kind of library,
// along with some of the other AST-related stuff implemented for apollo-client.
const TYPENAME_FIELD: FieldNode = {
    kind: Kind.FIELD,
    alias: null,
    name: {
        kind: Kind.NAME,
        value: '__typename',
    },
};

export type QueryTransformer = (doc: DocumentNode) => DocumentNode;

interface WritableSelectionSetNode extends SelectionSetNode {
    selections: SelectionNode[];
}
function addTypenameToSelectionSet(selectionSet: WritableSelectionSetNode, isRoot = false) {
    if (selectionSet.selections) {
        if (!isRoot) {
            const alreadyHasThisField = selectionSet.selections.some((selection) => {
                return selection.kind === 'Field' && (selection as FieldNode).name.value === '__typename';
            });

            if (!alreadyHasThisField) {
                selectionSet.selections.push(TYPENAME_FIELD);
            }
        }

        selectionSet.selections.forEach((selection) => {
            if (selection.kind === 'Field' || selection.kind === 'InlineFragment') {
                if (selection.selectionSet) {
                    addTypenameToSelectionSet(selection.selectionSet as WritableSelectionSetNode);
                }
            }
        });
    }
}

export const addTypenameTransformer: QueryTransformer = (doc: DocumentNode) => {
    const docClone = JSON.parse(JSON.stringify(doc));

    docClone.definitions.forEach((definition: DefinitionNode) => {
        const isRoot = definition.kind === 'OperationDefinition';
        addTypenameToSelectionSet(
            (definition as OperationDefinitionNode).selectionSet as WritableSelectionSetNode,
            isRoot,
        );
    });

    return docClone;
};
const lineNumberByIndex = (index, content) => {
    return content.substring(0, index).split('\n').length;
};

const extractVariableName = (content) => {
    const regex = /(const|let|var)\s+([\w]+)/;
    const results = regex.exec(content);
    return results[2];
};

interface ParsedQuery {
    content: string;
    lineNumber: {
        start: number;
        end: number;
    };
    variableName: string;
    column: number;
}
const findOccurrences = (needle, haystack): ParsedQuery[] => {
    let match;
    const result = [];
    const lines = haystack.split(/\n/g);
    // eslint-disable-next-line no-cond-assign
    while ((match = needle.exec(haystack))) {
        const pos = lineNumberByIndex(needle.lastIndex, haystack);
        const startIndexOf = haystack.indexOf(match[0]);
        const lineNumber = {
            start: lineNumberByIndex(startIndexOf, haystack),
            end: pos,
        };

        const variableName = extractVariableName(lines[lineNumber.start - 1]);
        result.push({
            content: match[1].trim(),
            lineNumber,
            variableName,
            column: needle.lastIndex - pos[1] - match[0].length,
        });
    }
    return result;
};
const extractQueryByPrefix = (code, prefix = 'gql') => {
    // m for multiline
    // g for matching multiple results
    // capture the text inside the template literal with parentheses
    const regex = new RegExp(`${prefix}\\s*\`([\\s\\S]+?)\``, 'mg');
    return findOccurrences(regex, code);
};

const replaceInterpolations = (queries: ParsedQuery[]) => {
    return queries.map((query) => {
        return {
            ...query,
            content: query.content.replace(INTERPOLATION_REGEX, (token, variableName) => {
                return queries.find((q) => q.variableName === variableName)?.content || '';
            }),
        };
    });
};

export const extractQueries = (content: string, addTypename: boolean): string[] => {
    return replaceInterpolations(extractQueryByPrefix(content)).flatMap((query) => {
        return addTypename
            ? print(addTypenameTransformer(JSON.parse(JSON.stringify(parse(query.content)))))
            : query.content;
    });
};

export const buildQueryMap = (queries: string[], addTypename: boolean) => {
    const extractGQL = new ExtractGQL({
        inputFilePath: '',
        queryTransformers: addTypename
            ? [
                  function (doc) {
                      return addTypenameTransformer(JSON.parse(JSON.stringify(doc)));
                  },
              ]
            : undefined,
    });

    const doc = parse(queries.join('\n'));
    const docMap = separateOperations(doc);
    return Object.keys(docMap).reduce((acc, operationName) => {
        const [query] = Object.keys(extractGQL.createMapFromDocument(docMap[operationName]));
        acc[operationName] = query;
        return acc;
    }, {});
};

interface Logger {
    debug: (...args: any[]) => void;
    info: (...args: any[]) => void;
    error: (...args: any[]) => void;
    getChildLogger: (...args: any[]) => Logger;
}
interface CreateQueryCollectionArgs {
    hasura: HasuraApi;
    name: string;
    logger: Logger;
    queryMap: Record<string, string>;
}
export const createQueryCollection = async ({ hasura, name, logger, queryMap }: CreateQueryCollectionArgs) => {
    let child = logger.getChildLogger('dropQueryCollection');
    try {
        child.info('Attempting to drop collection "%s"', name);
        const response = await hasura.dropQueryCollection(name);
        child.debug('response', response);
    } catch (e) {
        if (e.code !== 'not-exists') {
            child.error('Error trying to drop collection "%s"', name);
            child.error(e);
            throw e;
        } else {
            child.info('Collection named "%s" was not found.', name);
        }
    }
    const queries = Object.keys(queryMap).map((operationName) => ({
        name: operationName,
        query: queryMap[operationName],
    }));
    child = logger.getChildLogger('createQueryCollection');
    try {
        child.info('Attempting to create collection "%s" with (%d) queries', name, queries.length);
        const response = await hasura.createQueryCollection({
            name,
            queries,
        });
        child.debug('response', response);
        child.info('Created collection "%s"', name);
    } catch (e) {
        child.error('Error trying to create collection "%s"', name);
        child.error(e);
        throw e;
    }

    child = logger.getChildLogger('addCollectionToAllowList');
    try {
        child.info('Attempting to add collection "%s" to the allow-list', name);
        const response = await hasura.addCollectionToAllowList(name);
        child.debug('response', response);
        child.info('Added collection "%s" to allow-list', name);
    } catch (e) {
        child.error('Error trying to add collection "%s" to allow-list', name);
        throw e;
    }
};
