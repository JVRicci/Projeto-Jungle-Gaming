import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

export default defineConfig({
    clientUrl: process.env.DATABASE_URL,
    entities: [],
    // discovery: {
    //     warnWhenNoEntities: false,
    // },
    extensions: [Migrator],
    migrations: {
        path: 'src/database/migrations',
        pathTs: 'src/database/migrations',
        tableName: 'mikro_orm_migrations',
        transactional: true,
        snapshot: false,
    }
});