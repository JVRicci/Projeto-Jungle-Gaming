import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../mikro-orm.config";

describe("Migrations reversíveis (PostgreSQL)", () => {
    let orm: MikroORM;

    beforeAll(async () => {
        orm = await MikroORM.init(config);
    });

    afterAll(async () => {
        await orm.migrator.up();
        await orm.close(true);
    });

    const tableExists = async (table: string): Promise<boolean> => {
        const rows = await orm.em
            .fork()
            .execute<{ r: string | null }[]>("SELECT to_regclass(?) AS r", [`public.${table}`]);
        return rows[0]?.r !== null;
    };

    it("executa up → down → up preservando schema reversível", async () => {
        const tables = [
            "wallets",
            "wager_transactions",
            "wallet_ledger_entries",
            "inbox_messages",
            "outbox_messages",
        ];

        await orm.migrator.up();
        for (const t of tables) expect(await tableExists(t)).toBe(true);

        await orm.migrator.down();
        for (const t of tables) expect(await tableExists(t)).toBe(false);

        await orm.migrator.up();
        for (const t of tables) expect(await tableExists(t)).toBe(true);
    });
});