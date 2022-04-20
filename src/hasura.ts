import fetch from 'node-fetch';

export interface CreateQueryCollectionArgs {
    name: string;
    comment?: string;
    queries: {
        name: string;
        query: string;
    }[];
}
interface HasuraApiConfig {
    host: string;
    secret: string;
}
class HasuraApi {
    constructor(private config: HasuraApiConfig) {}

    async createQueryCollection({ name, comment = '', queries }: CreateQueryCollectionArgs) {
        return this.call('create_query_collection', {
            name,
            comment,
            definition: {
                queries,
            },
        });
    }

    async dropQueryCollection(collection: string) {
        return this.call('drop_query_collection', {
            collection,
            cascade: true,
        });
    }

    private async call(type: string, args: Record<string, any>) {
        return fetch(`${this.config.host}/v1/metadata`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-hasura-role': 'admin',
                'x-hasura-admin-secret': this.config.secret,
            },
            body: JSON.stringify({
                type,
                args,
            }),
        }).then((r) => r.json());
    }

    async addCollectionToAllowList(name: string) {
        return this.call('add_collection_to_allowlist', {
            collection: name,
        });
    }
}

export default HasuraApi;
