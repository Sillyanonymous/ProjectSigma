import { Router } from 'express';
import { config, ensureUserDirs, userPaths } from '../config.js';
import {
    openServerDb, listUsers, getUser, createUser, updateUser, setPassword, deleteUser, countAdmins,
} from '../db/server-store.js';
import { cancelAccountJobs } from '../lib/ext-jobs.js';
import { forgetAccount } from '../lib/account-teardown.js';

// Behind requireAdmin. every mutation guards against an admin locking themselves out and zero admins left

export const adminRouter = Router();

adminRouter.use((req, res, next) => {
    if (!config.multiUser) return res.status(400).json({ error: 'multi-user is disabled on this server' });
    next();
});

adminRouter.get('/users', (req, res) => {
    res.json(listUsers(openServerDb()));
});

adminRouter.post('/users', (req, res) => {
    const { handle, displayName, password, admin } = req.body || {};
    const user = createUser(openServerDb(), {
        handle: typeof handle === 'string' ? handle.toLowerCase().trim() : handle,
        displayName,
        password,
        admin: admin === true,
        mustChangePassword: true,
    });
    ensureUserDirs(user.handle);
    res.status(201).json({ handle: user.handle, displayName: user.display_name, admin: !!user.admin });
});

adminRouter.patch('/users/:handle', (req, res) => {
    const db = openServerDb();
    const target = getUser(db, req.params.handle);
    if (!target) return res.status(404).json({ error: 'no such user' });
    const { displayName, admin, enabled, password } = req.body || {};
    // types first: the store reads a flag by truthiness, so a 0 would slip past guards looking for false
    for (const [name, v] of [['admin', admin], ['enabled', enabled]]) {
        if (v !== undefined && typeof v !== 'boolean') return res.status(400).json({ error: `${name} must be true or false` });
    }
    if (displayName !== undefined && typeof displayName !== 'string') return res.status(400).json({ error: 'displayName must be a string' });
    if (password !== undefined && (typeof password !== 'string' || password.length < 4)) {
        return res.status(400).json({ error: 'password must be at least 4 characters' });
    }

    const self = target.handle === req.userHandle;
    if (self && admin === false) return res.status(400).json({ error: 'cannot remove your own admin flag' });
    if (self && enabled === false) return res.status(400).json({ error: 'cannot disable your own account' });
    if (target.admin && admin === false && countAdmins(db) === 1) {
        return res.status(400).json({ error: 'cannot demote the last admin' });
    }
    if (target.admin && enabled === false && countAdmins(db) === 1) {
        return res.status(400).json({ error: 'cannot disable the last admin' });
    }

    updateUser(db, target.handle, { displayName, admin, enabled });
    // a disabled account's extension jobs stop with its logins: nobody is left to run for
    if (enabled === false) cancelAccountJobs(target.handle, 'the account was disabled');
    // admin resets force a change on the next login
    if (password !== undefined) setPassword(db, target.handle, password, { mustChange: true });
    const fresh = getUser(db, target.handle);
    res.json({
        handle: fresh.handle,
        displayName: fresh.display_name,
        admin: !!fresh.admin,
        enabled: !!fresh.enabled,
        mustChangePassword: !!fresh.must_change_password,
    });
});

adminRouter.delete('/users/:handle', (req, res) => {
    const db = openServerDb();
    const target = getUser(db, req.params.handle);
    if (!target) return res.status(404).json({ error: 'no such user' });
    if (target.handle === req.userHandle) return res.status(400).json({ error: 'cannot delete your own account' });
    if (target.admin && countAdmins(db) === 1) return res.status(400).json({ error: 'cannot delete the last admin' });

    deleteUser(db, target.handle);
    forgetAccount(target.handle);
    // the library stays: deleting user data is a deliberate filesystem call, not a side effect of a login delete
    res.json({ ok: true, keptData: userPaths(target.handle).root });
});
