// SPDX-License-Identifier: MIT

// Testing an extension with the kit: the real server, in process, on a temporary home. Run:
//     node --test extensions/bundled/hello-world/test/hello-world.test.mjs
// Yours: startSigma({ extensions: ['path/to/your-extension'] }).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSigma } from '../../../../tools/extension-kit/index.mjs';

// the tour ships with the app, so there is nothing to install
const sigma = await startSigma({ prefix: 'hello-world-test' });
after(() => sigma.close());
const me = sigma.session;
const tour = me.ext('hello-world');

test('its routes answer only once the account switches it on', async () => {
    assert.equal((await tour('/hello')).status, 404);
    assert.equal((await me.enable('hello-world')).status, 200);
    const { status, body } = await tour('/hello');
    assert.equal(status, 200);
    assert.deepEqual(body, { hello: 'default', from: 'hello-world', greeting: 'Hello' });
});

test('a wave is written, reported as the character\'s change, and carried by the list rows', async () => {
    const { id } = await me.importCard({ name: 'Nova', first_mes: 'Hi.' });
    const mark = sigma.changes.length;
    assert.deepEqual((await tour(`/wave/${id}`, 'PUT')).body, { waves: 1 });
    const report = sigma.changes.slice(mark).find(r => r.fields?.includes('hello-world.waves'));
    assert.equal(report?.extension, 'hello-world');
    assert.deepEqual(report.ids, [id]);
    const rows = (await me.api('/characters?count=false&limit=100')).body.items;
    assert.equal(rows.find(r => r.id === id).ext['hello-world'].waves, 1);
});

test('a selection is one request and one change', async () => {
    const ids = [(await me.importCard({ name: 'Orion' })).id, (await me.importCard({ name: 'Vega' })).id];
    const mark = sigma.changes.length;
    const { body } = await tour('/waves', 'PUT', { ids: [...ids, 'no-such-character'] });
    assert.deepEqual(body, { affected: ids, skipped: ['no-such-character'] });
    assert.equal(sigma.changes.slice(mark).filter(r => r.fields?.includes('hello-world.waves')).length, 1);
});

test('its store guard refuses its sentinel name, and the name stands', async () => {
    const { id } = await me.importCard({ name: 'Plain' });
    const refused = await me.api(`/characters/${id}`, 'PATCH', { fields: { name: 'Refused by Hello World' } });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /Hello World refuses that name/);
    assert.equal((await me.api(`/characters/${id}`)).body.card.data.name, 'Plain');
});

test('{{hello}} reaches the prompt a chat builds', async () => {
    const { id } = await me.importCard({ name: 'Lyra', description: 'Greets with {{hello}}.', first_mes: 'Hi.' });
    const chat = (await me.api(`/characters/${id}/chats`, 'POST', { name: 'Test chat' })).body;
    const prompt = (await me.api(`/chats/${chat.id}/prompt`)).body.messages.map(m => m.content).join('\n');
    assert.match(prompt, /Greets with Hello\./);
});

test('{{hello}} takes a name, or a list of them', async () => {
    const { id } = await me.importCard({ name: 'Lyra', description: '{{hello::Nova}} / {{hello::Nova::Orion::Vega}} / {{hello::{{char}}}}', first_mes: 'Hi.' });
    const chat = (await me.api(`/characters/${id}/chats`, 'POST', { name: 'Names chat' })).body;
    const prompt = (await me.api(`/chats/${chat.id}/prompt`)).body.messages.map(m => m.content).join('\n');
    assert.match(prompt, /Hello, Nova \/ Hello, Nova, Orion and Vega \/ Hello, Lyra/);
});

test('its client half, in the page an account\'s tab runs', async () => {
    const until = async (pred) => { for (let i = 0; i < 200 && !pred(); i++) await new Promise(r => setTimeout(r, 20)); return pred(); };
    const page = await me.page();
    try {
        // the account switched the tour on in the first test, so the page's boot loads it
        await page.boot();
        assert.equal(page.host.getExtensionStatus('hello-world')?.state, 'loaded');
        // its own command, as any extension or menu runs it
        assert.equal(await page.registry.runCommand('hello-world.greet', { to: 'the kit' }), 'Hello, the kit!');
        assert.deepEqual(page.log.toasts.at(-1), ['Hello, the kit!', 'info']);
        // the chip a grid card shows, from the row the server lists
        const { id } = await me.importCard({ name: 'Chip' });
        await tour(`/wave/${id}`, 'PUT');
        const row = (await me.api(`/characters?count=false&ids=${id}`)).body.items[0];
        assert.deepEqual(page.host.badgesFor(row).map(c => c.label), ['1']);
        // the details tab, painted from the server's count
        const pane = page.dom.mountPoint();
        page.host.renderDetailTab('hello-world/waves', pane, { character: { id, name: 'Chip' }, isCurrent: () => true });
        assert.ok(await until(() => /waved at Chip 1 time\./.test(pane.textContent)), pane.textContent);
        // a wave made elsewhere reaches the open tab over the feed, and the tab reads it again
        await page.listen();
        await tour(`/wave/${id}`, 'PUT');
        assert.ok(await until(() => /waved at Chip 2 times\./.test(pane.textContent)), pane.textContent);
    } finally {
        page.close();
    }
});

test('its daily schedule ticks for the account that has it on', async () => {
    // the kit arms no timers: a tick is asked for, its job queued for every account with the tour on
    assert.equal(sigma.tick('hello-world', 'tick'), 1);
    const until = async (fn) => { for (let i = 0; i < 100; i++) { if (await fn()) return true; await new Promise(r => setTimeout(r, 20)); } return false; };
    assert.ok(await until(async () => (await tour('/tour')).body?.lastTick != null), 'the tick ran and noted itself');
});

test('its rule field reads its index at scale, with statistics', async () => {
    // a plan pin: the rule field's query shape over a thousand rows, with a running server's statistics
    const ids = sigma.seed('default', 1000);
    await tour('/waves', 'PUT', { ids });
    sigma.analyze();
    const plan = sigma.explain('default', 'SELECT char_id FROM x_hello_world_waves WHERE waves > ?', 5).join(' | ');
    assert.match(plan, /SEARCH x_hello_world_waves USING (COVERING )?INDEX x_hello_world_waves_waves/);
});
