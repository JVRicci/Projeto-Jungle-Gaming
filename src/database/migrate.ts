import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config'; 

const command = process.argv[2];
const orm = await MikroORM.init(config);

try {
    if (command === 'up') {
        await orm.migrator.up();
    } else if (command === 'down') {
        await orm.migrator.down();
    } else {
        throw new Error(`Comando desconhecido: ${command}. Use 'up' ou 'down'.`);
    }
} finally {
    await orm.close(true);
}