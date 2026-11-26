import React, { useEffect, useRef, useState } from 'react';
import type { PageProps } from '../App';
import { Btn, Field, Ico, copyText, useToast } from '../components/ui';
import { call, fmtCost } from '../lib/api';

const giftAmount = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
const giftMoney = (value: number | null) => value === null ? null : `$${value.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 })}`;

export default function Membership({ reload, go }: PageProps) {
  const [status, setStatus] = useState<any>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [code, setCode] = useState('');
  const [twoFactor, setTwoFactor] = useState<any>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<any>(null);
  const [inviteCode, setInviteCode] = useState('');
  const [approvalHelp, setApprovalHelp] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState<{ deviceId: string; keyId: string } | null>(null);
  const [groups, setGroups] = useState<any[]>([]);
  const [groupId, setGroupId] = useState<number | ''>('');
  const [loading, setLoading] = useState(false);
  const [statusKnown, setStatusKnown] = useState(false);
  const [groupError, setGroupError] = useState('');
  const loadSequence = useRef(0);
  const running = useRef(false);
  const toast = useToast();
  const desktop = !!window.aurora;
  function clearLogin(config = status?.config) {
    setStatus({ ok: true, loggedIn: false, config }); setGroups([]); setGroupId(''); setReceipt(null); setTwoFactor(null);
    setPassword(''); setAccessToken(''); setCode('');
  }
  async function load(options: { preserveError?: string } = {}) {
    const sequence = ++loadSequence.current;
    const preferredGroup = groupId;
    setLoading(true); setStatusKnown(false);
    try {
      const r = await call('member.status');
      if (sequence !== loadSequence.current) return;
      if (r?.loggedIn === false) clearLogin(r.config || status?.config);
      if (r?.ok === false) throw new Error(r.message || '会员状态暂不可读');
      setStatus(r); setStatusKnown(true); setError(options.preserveError || r.message || ''); setGroupError(''); setGroups([]); setGroupId('');
      if (r.loggedIn) {
        try {
          const g = await call('member.groups');
          if (sequence !== loadSequence.current) return;
          if (g?.authExpired || g?.loggedIn === false) { clearLogin(r.config); setError(g.message || '登录已过期，请重新登录。'); return; }
          if (!g.ok) throw new Error(g.message || '会员服务分组暂不可读');
          setGroups(g.groups || []); setGroupId(g.groups?.some((v: any) => v.id === preferredGroup && v.supported !== false) ? preferredGroup : g.groups?.find((v: any) => v.supported !== false)?.id ?? '');
        } catch (e: any) { if (sequence === loadSequence.current) setGroupError(e.message || '会员服务分组暂不可读'); }
      }
    } catch (e: any) { if (sequence === loadSequence.current) { setStatusKnown(false); setGroups([]); setGroupId(''); setError([options.preserveError, `状态确认失败：${e.message || '请稍后重试'}`].filter(Boolean).join('；')); } }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  }
  useEffect(() => { if (desktop) void load(); return () => { loadSequence.current++; }; }, []);
  async function perform(action: string, payload: any = {}) {
    if (running.current || loading) return;
    running.current = true; loadSequence.current++;
    setBusy(action); setError('');
    let expired = false;
    try {
      const result = await call(action, payload);
      if (result?.authExpired || result?.loggedIn === false) { expired = true; clearLogin(); setStatusKnown(true); }
      if (!result.ok) {
        if (result.code === 'DEVICE_APPROVAL_REQUIRED') setApprovalHelp(true);
        throw new Error(result.message || result.error || '操作未完成');
      }
      if (action === 'member.invite') {
        if (!result.inviteCode || typeof result.inviteCode !== 'string') throw new Error('平台未返回本机邀请码，请稍后重新查看。');
        setInviteCode(result.inviteCode);
        return;
      }
      if (action === 'member.deviceInfo') {
        if (!/^[a-f0-9]{64}$/.test(result.deviceId) || !/^[a-f0-9]{64}$/.test(result.keyId)) throw new Error('本机授权信息暂不可读。');
        setDeviceInfo({ deviceId: result.deviceId, keyId: result.keyId });
        return;
      }
      if (result.requires2fa) { setTwoFactor(result); return; }
      if (action === 'member.login' || action === 'member.login2fa' || action === 'member.bind') { setPassword(''); setAccessToken(''); setCode(''); setTwoFactor(null); }
      if (action === 'member.claim') {
        setReceipt(result);
        // A confirmed receipt remains visible even if the following status or
        // group read fails. No inferred credit amount is written into state.
        setStatus((previous: any) => ({ ...previous, ...(result.member ? { member: result.member } : {}), ...(result.gift ? { gift: result.gift } : {}) }));
      }
      if (action === 'member.logout') { clearLogin(); setStatusKnown(true); setGroupError(''); }
      if (action === 'member.addProvider') {
        let models: any;
        try { models = await call('provider.models', { providerId: result.providerId }); }
        catch (e: any) { models = { ok: false, message: e.message }; }
        await reload(); toast.push(models.ok ? result.message : '供应商已添加，模型同步暂未成功，可在配置时手动填写。', models.ok ? 'ok' : 'bad'); go('agents'); return;
      }
      await load();
      if (result.message) toast.push(result.message, 'ok');
    } catch (e: any) {
      const message = e.message || '操作未完成'; setError(message);
      if (action === 'member.claim' || expired) {
        setStatusKnown(false);
        // A failed claim may already have reached the service. Only read its
        // status here; a further claim always requires another explicit click.
        await load({ preserveError: message });
      }
    }
    finally { running.current = false; setBusy(''); }
  }
  const gift = status?.gift || status?.data?.gift || {};
  const member = status?.member || status?.data?.member || {};
  const claimed = gift.status === 'claimed' || gift.status === 'completed' || gift.claimed || !!gift.claimedAt;
  const pending = gift.status === 'pending';
  const review = gift.status === 'review';
  const recordedGift = claimed || pending || review;
  const config = status?.config;
  const deviceApprovalHint = statusKnown && config?.enabled && typeof config.deviceAutoApprove === 'boolean'
    ? config.deviceAutoApprove
      ? '首次领取时，平台自动核准新设备。'
      : '平台已开启人工核准。新设备首次领取前，请联系管理员核对设备授权信息。'
    : '';
  // Issued grants keep the amount confirmed by the service, even when a later
  // campaign changes its amount or stops accepting new claims.
  const amount = recordedGift ? giftAmount(gift.amountUsd) : statusKnown ? giftAmount(gift.amountUsd) ?? giftAmount(config?.giftUsd) : null;
  const amountText = giftMoney(amount);
  const activityClosed = statusKnown && config?.giftEnabled === false;
  const canClaim = statusKnown && status?.loggedIn && config?.enabled !== false && !claimed && !review && gift.status !== 'ineligible'
    && (pending || (config?.giftEnabled === true && amount !== null && gift.status === 'eligible' && gift.eligible !== false));
  const claimLabel = busy === 'member.claim' ? '正在确认到账…' : claimed ? '新客额度已到账' : !statusKnown ? '请先刷新领取状态'
    : pending ? '重新确认到账' : review ? '等待人工核对' : activityClosed ? '新客活动暂未开放'
      : !amountText ? '领取额度待确认' : `领取 ${amountText} 平台额度`;
  const giftLabel = claimed ? '已到账平台额度' : pending ? '本次待确认额度' : review ? '待核对平台额度' : '新客平台额度';
  return <>
    <div className="page-head"><div><div className="eyebrow">YUNQIAO.ME</div><h1>云桥会员</h1><p>绑定平台会员，在客户端领取新客额度，快速开始第一次对话。</p></div><Btn onClick={() => call('app.openExternal', { url: 'https://api.yunqiao.me' })}>打开平台网站 ↗</Btn></div>
    <div className="member-hero"><div className="member-gift-icon"><Ico name="bolt" size={30} /></div><div className="grow"><span className="eyebrow">WELCOME GIFT</span><h2>第一份灵感，从这里开始。</h2><p>{statusKnown && config?.giftMessage || '绑定平台会员，查看当前新客活动与领取资格。'}</p></div><div className="member-gift-value" aria-label="平台赠送额度"><strong>{amountText || (activityClosed && !recordedGift ? '暂未开放' : '待确认')}</strong><span>{giftLabel}</span></div></div>
    {!desktop ? <div className="notice">请在 Windows 或 macOS 桌面客户端登录并绑定本机，领取额度。</div> : <>
      {error && <div className="notice warning" role="alert">{error}<div className="grow" /><Btn size="sm" disabled={loading || !!busy} onClick={() => { void load(); }}>重试</Btn></div>}
      {config?.enabled === false && <div className="notice">{config.message || '会员服务暂不可用，请稍后重试。'}</div>}
      {activityClosed && config?.enabled !== false && <div className="notice">{pending ? '新客活动已暂停，仍可确认此前申请的到账结果。' : '新客活动暂未开放。会员登录、已有余额和供应商配置仍可正常使用。'}</div>}
      {status?.loggedIn && typeof status.canRefresh === 'boolean' && <div className={`notice${status.canRefresh ? '' : ' warning'}`} role="status">{status.canRefresh
        ? '登录状态会自动续期，无需每小时重新登录。退出登录、平台撤销凭据或长期未使用后，需要重新验证。'
        : '当前登录不支持自动续期，访问令牌到期后需要重新绑定。使用邮箱与密码重新登录，可在平台支持时开启自动续期。'}</div>}
      <div className="grid cols-2">
        <div className="card"><div className="card-title">{status?.loggedIn ? '我的平台会员' : '登录并绑定本机'}</div>{status?.loggedIn ? <><h2>{member.email || member.username || '已登录会员'}</h2><p className="muted">平台余额 {fmtCost(typeof member.balance === 'number' ? member.balance : undefined)}</p><div className="notice"><Ico name="shield" /><span>已绑定当前客户端。登录凭据由操作系统加密保存，不进入配置导出。</span></div><Field label="选择平台服务分组" hint="不同分组提供不同模型与倍率，添加后自动读取该分组可用模型。"><select className="select" aria-label="会员服务分组" disabled={loading || !!busy} value={groupId} onChange={e => setGroupId(Number(e.target.value))}><option value="">选择服务分组</option>{groups.map(g => <option key={g.id} value={g.id} disabled={g.supported === false}>{g.name} · {g.platform}{g.supported === false ? ' · 暂需手动配置' : ''}{g.rateMultiplier ? ` · ${g.rateMultiplier} 倍` : ''}</option>)}</select></Field>{groupError && <div className="notice warning" role="alert">{groupError}<Btn size="sm" disabled={loading || !!busy} onClick={() => { void load({ preserveError: error }); }}>重试</Btn></div>}<div className="row"><Btn disabled={loading || !!busy} onClick={() => perform('member.logout')}>退出会员登录</Btn><Btn disabled={loading || !!busy || !groupId} variant="primary" onClick={() => perform('member.addProvider', { groupId })}>添加云桥供应商 →</Btn></div></> : <form onSubmit={e => { e.preventDefault(); void perform(twoFactor ? 'member.login2fa' : 'member.login', twoFactor ? { tempToken: twoFactor.tempToken, code } : { email, password }); }}>
          {twoFactor ? <><p>请输入 {twoFactor.emailMasked || '账号'} 的验证器动态码。</p><Field label="两步验证码"><input className="input" aria-label="会员两步验证码" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} /></Field></> : <><Field label="平台邮箱"><input className="input" type="email" aria-label="平台会员邮箱" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></Field><Field label="平台密码"><input className="input" type="password" aria-label="平台会员密码" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></Field></>}
          <button className="btn primary" type="submit" disabled={loading || !!busy || !status || status.config?.enabled === false}>{['member.login', 'member.login2fa'].includes(busy) ? '处理中…' : twoFactor ? '验证并绑定' : '登录并绑定本机'}</button>
          <details style={{ marginTop: 16 }}><summary>通过平台访问令牌绑定</summary><p className="hint">适用于已在平台登录、使用单点登录或需要网页验证的会员。使用平台账号访问令牌，不能使用模型 API Key。此方式不能自动续期，令牌到期后需重新绑定。</p><Field label="账号访问令牌"><input className="input" type="password" aria-label="会员访问令牌" autoComplete="off" value={accessToken} onChange={e => setAccessToken(e.target.value)} /></Field><Btn disabled={loading || !!busy || !accessToken} onClick={() => perform('member.bind', { accessToken })}>验证并绑定</Btn></details>
        </form>}
          <section className="member-invite" aria-labelledby="member-invite-title">
            <h3 id="member-invite-title">本机注册邀请码</h3>
            <p className="hint">{deviceApprovalHint}每台设备对应一个邀请码，可用于一次注册。重新查看会返回原码。</p>
            {inviteCode && <Field label="本机邀请码"><input className="input mono" aria-label="本机邀请码" readOnly value={inviteCode} onFocus={e => e.target.select()} /></Field>}
            <div className="row">
              <Btn size="sm" disabled={loading || !!busy || config?.enabled === false} onClick={() => perform('member.invite')}>{busy === 'member.invite' ? '正在获取…' : inviteCode ? '重新查看邀请码' : '获取本机邀请码'}</Btn>
              {inviteCode && <Btn size="sm" onClick={async () => { await copyText(inviteCode); toast.push('邀请码已复制', 'ok'); }}>复制邀请码</Btn>}
              {!status?.loggedIn && <button className="text-button" type="button" onClick={() => call('app.openExternal', { url: 'https://api.yunqiao.me/register' })}>前往平台注册 ↗</button>}
            </div>
            <details open={approvalHelp} onToggle={e => setApprovalHelp(e.currentTarget.open)}><summary>设备授权信息</summary>
              <p className="hint">平台要求人工核准、本机授权已撤销或设备密钥已更换时，请联系管理员核对下方设备标识和公钥指纹。</p>
              {deviceInfo ? <>
                <Field label="设备标识"><input className="input mono" aria-label="设备标识" readOnly value={deviceInfo.deviceId} /></Field>
                <Field label="设备公钥指纹"><input className="input mono" aria-label="设备公钥指纹" readOnly value={deviceInfo.keyId} /></Field>
                <Btn size="sm" onClick={async () => { await copyText([deviceInfo.deviceId, deviceInfo.keyId].join('\n')); toast.push('已复制设备标识和公钥指纹', 'ok'); }}>复制授权信息</Btn>
              </> : <Btn size="sm" disabled={loading || !!busy} onClick={() => perform('member.deviceInfo')}>查看本机授权信息</Btn>}
            </details>
          </section>
        </div>
        <div className="card"><div className="card-title">新客额度<span className={`chip ${claimed ? 'ok' : ''}`}>{claimed ? '已到账' : !statusKnown ? '资格待确认' : pending ? '到账确认中' : gift.status === 'ineligible' ? '本机已领取' : review ? '需人工核对' : activityClosed ? '活动未开放' : '等待领取'}</span></div><div className="member-steps"><p><span>1</span><b>登录平台会员</b><small>用现有平台账号登录，或先注册。</small></p><p><span>2</span><b>{claimed ? `已领取${amountText ? ` ${amountText}` : '平台额度'}` : pending || review ? `核对本次${amountText ? ` ${amountText}` : '领取额度'}` : `绑定并领取${amountText ? ` ${amountText}` : '平台额度'}`}</b><small>服务器确认资格后，将本次活动额度充值到会员账户。</small></p><p><span>3</span><b>选择客户端开始使用</b><small>添加云桥供应商，选择模型，预览后应用配置。</small></p></div><Btn variant="primary" disabled={loading || !!busy || !canClaim} onClick={() => perform('member.claim')}>{claimLabel}</Btn>{(gift.reason || gift.message) && <p className="hint">{gift.reason || gift.message}</p>}{receipt && <div className="notice" style={{ marginTop: 16 }}>{receipt.message || '领取请求已处理，可刷新查看平台余额。'}</div>}<p className="hint" style={{ marginTop: 20 }}>每个会员、每台获准设备限领一次。切换账号或重复点击会核对原领取记录。活动金额和开放状态由平台公布，已申请额度以该次领取记录为准。赠送额度仅用于 yunqiao.me 平台模型服务。</p></div>
      </div>
    </>}
  </>;
}
