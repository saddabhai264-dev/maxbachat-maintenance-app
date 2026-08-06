const pool = require('./db');
const webpush = require('web-push');

function configureWebPush() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@maxbachat.local',
    publicKey,
    privateKey
  );
  return true;
}

function normalizeWhatsappNumber(phone) {
  return String(phone || '').replace(/[^\d]/g, '');
}

async function sendViaGreenApi(phone, message) {
  const instanceId = process.env.GREEN_API_INSTANCE_ID;
  const token = process.env.GREEN_API_TOKEN;
  const number = normalizeWhatsappNumber(phone);
  if (!instanceId || !token) throw new Error('GREEN_API_INSTANCE_ID or GREEN_API_TOKEN is not set');
  if (!number) throw new Error('Phone number is missing');

  const stateUrl = `https://api.green-api.com/waInstance${instanceId}/getStateInstance/${token}`;
  const stateResponse = await fetch(stateUrl);
  const state = stateResponse.ok ? await stateResponse.json() : null;
  if (!stateResponse.ok || state.stateInstance !== 'authorized') {
    throw new Error(`Green API instance state is ${state && state.stateInstance ? state.stateInstance : 'unavailable'}`);
  }

  const url = `https://api.green-api.com/waInstance${instanceId}/sendMessage/${token}`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chatId: `${number}@c.us`,
      message
    })
  });
}

async function sendViaWebhook(payload) {
  return fetch(process.env.NOTIFICATION_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function dispatchNotification({ issueId, userId, phone, eventType, message }) {
  let logId = null;
  try {
    const inserted = await pool.query(
      `INSERT INTO notification_logs (issue_id, user_id, phone, event_type, message)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [issueId || null, userId || null, phone || null, eventType, message]
    );
    logId = inserted.rows[0].id;

    if (!phone) {
      await pool.query('UPDATE notification_logs SET status=$1 WHERE id=$2', ['queued', logId]);
      return;
    }

    let response = null;
    if (process.env.NOTIFICATION_PROVIDER === 'greenapi') {
      response = await sendViaGreenApi(phone, message);
    } else if (process.env.NOTIFICATION_WEBHOOK_URL) {
      response = await sendViaWebhook({ issueId, userId, phone, eventType, message });
    } else {
      await pool.query('UPDATE notification_logs SET status=$1 WHERE id=$2', ['queued', logId]);
      return;
    }

    let responseError = null;
    if (response && !response.ok) {
      try {
        responseError = (await response.text()).slice(0, 500);
      } catch (e) {
        responseError = `HTTP ${response.status}`;
      }
    }

    await pool.query(
      'UPDATE notification_logs SET status=$1, error=$2 WHERE id=$3',
      [response.ok ? 'sent' : 'failed', response.ok ? null : responseError || `HTTP ${response.status}`, logId]
    );
  } catch (e) {
    console.error('Notification failed:', e);
    if (logId) {
      await pool.query('UPDATE notification_logs SET status=$1, error=$2 WHERE id=$3', ['failed', e.message, logId]);
    }
  }
}

async function notifyUsers(users, issueId, eventType, message) {
  await Promise.all((users || []).map(u => dispatchNotification({
    issueId,
    userId: u.id,
    phone: u.phone,
    eventType,
    message
  })));
  await sendPushToUsers(users, { issueId, eventType, message });
}

async function sendPushToUsers(users, payload) {
  if (!configureWebPush()) return;
  const ids = [...new Set((users || []).map(u => u && u.id).filter(Boolean))];
  if (!ids.length) return;

  try {
    const { rows } = await pool.query(
      `SELECT id, user_id, subscription FROM push_subscriptions WHERE user_id = ANY($1)`,
      [ids]
    );
    await Promise.all(rows.map(async row => {
      try {
        await webpush.sendNotification(row.subscription, JSON.stringify({
          title: 'MAXBACHAT Maintenance Alert',
          body: payload.message,
          issueId: payload.issueId,
          eventType: payload.eventType,
          url: '/'
        }));
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          await pool.query('DELETE FROM push_subscriptions WHERE id=$1', [row.id]);
        } else {
          console.error('Push notification failed:', e.message);
        }
      }
    }));
  } catch (e) {
    console.error('Push notification lookup failed:', e);
  }
}

async function usersForIssueBranch(branchCode, roles = []) {
  const { rows } = await pool.query(
    `SELECT id, name, phone, role FROM users
     WHERE is_active=true AND branch_code=$1 AND role = ANY($2)`,
    [branchCode, roles]
  );
  return rows;
}

async function coordinatorsForBranch(branchCode) {
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.phone, u.role
     FROM users u
     JOIN user_routes r ON r.user_id = u.id
     WHERE u.is_active=true AND u.role='coordinator' AND r.branch_code=$1`,
    [branchCode]
  );
  return rows;
}

async function allMaintenanceUsers() {
  const { rows } = await pool.query(
    `SELECT DISTINCT id, name, phone, role
     FROM users
     WHERE is_active=true AND role='coordinator'`
  );
  return rows;
}

async function maintenanceHeadUsers() {
  const { rows } = await pool.query(
    `SELECT id, name, phone, role
     FROM users
     WHERE is_active=true AND role='coordinator' AND is_head=true`
  );
  return rows;
}

async function forcedMaintenanceRecipients(branchCode) {
  const routed = await coordinatorsForBranch(branchCode);
  const heads = await maintenanceHeadUsers();
  return [...routed, ...heads].filter((u, index, list) => (
    u && u.id && list.findIndex(x => x.id === u.id) === index
  ));
}

async function forceNotifyMaintenance(issue, openedBy) {
  const recipients = await forcedMaintenanceRecipients(issue.branchCode);
  const branch = issue.branchName || issue.branchCode;
  const title = String(issue.title || '').trim();
  const category = String(issue.category || '').trim();
  const openedByName = openedBy && openedBy.name ? openedBy.name : 'Branch captain';
  const message = [
    'URGENT MAXBACHAT MAINTENANCE ALERT',
    `Issue: ${issue.id}`,
    `Branch: ${branch}`,
    `Title: ${title}`,
    category ? `Category: ${category}` : null,
    `Reported by: ${openedByName}`,
    'Please open the maintenance app and take action.'
  ].filter(Boolean).join('\n');

  await notifyUsers(recipients, issue.id, 'force_issue_created', message);
  return recipients;
}

async function ceoUsers() {
  const { rows } = await pool.query(
    `SELECT id, name, phone, role FROM users WHERE is_active=true AND role='ceo'`
  );
  return rows;
}

module.exports = {
  dispatchNotification,
  notifyUsers,
  usersForIssueBranch,
  coordinatorsForBranch,
  allMaintenanceUsers,
  maintenanceHeadUsers,
  forcedMaintenanceRecipients,
  forceNotifyMaintenance,
  ceoUsers
};
