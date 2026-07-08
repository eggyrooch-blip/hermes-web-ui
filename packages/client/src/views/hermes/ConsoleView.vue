<script setup lang="ts">
// Hermes Console — M1a shell. Feishu-login inherited from the app; role comes
// from /api/auth/me (server-authoritative). Developer plane is default & self-
// scoped; ops plane appears only for admins (nav gating is convenience — the
// real gate is requireConsoleAdmin on /api/console/*).
import { ref, onMounted, computed } from 'vue'

type Role = 'admin' | 'developer'
const role = ref<Role>('developer')
const me = ref<{ name?: string; openid?: string; unionId?: string }>({})
const screen = ref<'overview' | 'profiles' | 'ingest' | 'guide'>('ingest')
const loading = ref(false)
const err = ref('')

const isAdmin = computed(() => role.value === 'admin')

async function j(path: string): Promise<any> {
  const r = await fetch(path, { credentials: 'include' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

// ── data holders ─────────────────────────────────────────────
const ov = ref<any>(null)
const reauth = ref<any[]>([])
const pf = ref<{ items: any[]; total: number }>({ items: [], total: 0 })
const pfDetail = ref<any>(null)
const q = ref('')
const dev = ref<any>(null)

async function loadOverview() {
  loading.value = true; err.value = ''
  try {
    ov.value = await j('/api/console/overview')
    const rp = await j('/api/console/reauth-pending'); reauth.value = rp.items || []
  } catch (e: any) { err.value = e.message } finally { loading.value = false }
}
async function searchProfiles() {
  loading.value = true; err.value = ''; pfDetail.value = null
  try {
    const u = new URLSearchParams({ limit: '50' }); if (q.value) u.set('q', q.value)
    pf.value = await j(`/api/console/profiles?${u}`)
  } catch (e: any) { err.value = e.message } finally { loading.value = false }
}
async function openDetail(name: string) {
  loading.value = true
  try { pfDetail.value = await j(`/api/console/profiles/${encodeURIComponent(name)}`) }
  catch (e: any) { err.value = e.message } finally { loading.value = false }
}
async function loadDev() {
  loading.value = true; err.value = ''
  try { dev.value = await j('/api/console/dev/me') }
  catch (e: any) { err.value = e.message } finally { loading.value = false }
}

function go(s: typeof screen.value) {
  screen.value = s
  if (s === 'overview') loadOverview()
  else if (s === 'profiles') searchProfiles()
  else if (s === 'ingest') loadDev()
}

onMounted(async () => {
  try {
    const meRes = await j('/api/auth/me')
    const u = meRes.user || {}
    role.value = u.consoleRole === 'admin' ? 'admin' : 'developer'
    me.value = { name: u.name, openid: u.openid, unionId: u.unionId }
  } catch { role.value = 'developer' }
  go('ingest') // everyone lands on the developer view first
})

const pill = (k: string) => `pill-${k}`
function credKind(s: string) { return s?.includes('auth') ? 'ok' : (s === 'missing' ? 'mut' : 'warn') }
</script>

<template>
  <div class="console-shell">
    <aside class="cside">
      <div class="cbrand"><span class="cmark">H</span><span class="cname">Hermes Console<small>multitenancy</small></span></div>

      <template v-if="isAdmin">
        <div class="cnavlab">运维 <span class="cnavtag">admin</span></div>
        <button class="cnav" :class="{on: screen==='overview'}" @click="go('overview')">总览</button>
        <button class="cnav" :class="{on: screen==='profiles'}" @click="go('profiles')">租户 / Profile</button>
      </template>

      <div class="cnavlab">开发者 <span class="cnavtag">全员默认</span></div>
      <button class="cnav" :class="{on: screen==='ingest'}" @click="go('ingest')">Agent 接入</button>
      <button class="cnav" :class="{on: screen==='guide'}" @click="go('guide')">发布指引</button>

      <div class="cfoot">
        <div>飞书登录:<b>{{ me.name || '当前用户' }}</b></div>
        <div class="cmono">{{ (me.unionId || me.openid || '').slice(0, 16) }}…</div>
        <div class="crole" :class="isAdmin ? 'r-admin' : 'r-dev'">{{ isAdmin ? '运维 admin' : '开发者' }}</div>
      </div>
    </aside>

    <main class="cmain">
      <div v-if="err" class="cerr">加载失败:{{ err }}</div>

      <!-- 总览 (admin) -->
      <section v-if="screen==='overview'">
        <h1 class="ch1">总览</h1>
        <p class="csub">实时聚合 · 待 reauth 缓存 {{ ov?.cache_age_s ?? '—' }}s</p>
        <div class="ccards" v-if="ov">
          <div class="ccard" :class="ov.skillhub?.failed ? 'crit' : 'ok'"><div class="ck">SkillHub 失败</div><div class="cv">{{ ov.skillhub?.failed ?? 0 }}</div></div>
          <div class="ccard" :class="ov.reauth_pending_count ? 'warn' : 'ok'"><div class="ck">待重新授权</div><div class="cv">{{ ov.reauth_pending_count ?? 0 }} <small>人</small></div></div>
          <div class="ccard ok"><div class="ck">活跃用户</div><div class="cv">{{ ov.active?.user ?? 0 }}</div></div>
          <div class="ccard ok"><div class="ck">群 / Agent</div><div class="cv">{{ ov.active?.group ?? 0 }} / {{ ov.active?.agent ?? 0 }}</div></div>
          <div class="ccard ok"><div class="ck">Broker</div><div class="cv" style="font-size:22px">{{ ov.broker?.alive ? '存活' : '离线' }}</div></div>
        </div>
        <div class="cpanel">
          <h3>需要关注</h3>
          <table v-if="reauth.length"><tr v-for="r in reauth" :key="r.open_id"><td><span :class="pill('warn')">凭证</span></td><td class="cmono">{{ r.profile }}</td><td>{{ r.reason }}</td></tr></table>
          <div v-else class="cempty">当前无异常</div>
        </div>
      </section>

      <!-- 租户 (admin) -->
      <section v-if="screen==='profiles'">
        <h1 class="ch1">租户 / Profile</h1>
        <div class="csearch"><input v-model="q" placeholder="搜索姓名 / ou_ / 群名 — 回车" @keydown.enter="searchProfiles" /></div>
        <div class="cpanel">
          <h3>共 {{ pf.total }} 条</h3>
          <table v-if="pf.items.length">
            <tr><th>名称</th><th>profile</th><th>类型</th><th>open_id</th></tr>
            <tr v-for="it in pf.items" :key="it.profile" class="crow" @click="openDetail(it.profile)">
              <td>{{ it.display_label || '—' }}</td><td class="cmono">{{ it.profile }}</td><td>{{ it.kind }}</td><td class="cmono">{{ (it.open_id||'—') }}</td>
            </tr>
          </table>
          <div v-else class="cempty">回车列出全部,或输入关键词</div>
        </div>
        <div v-if="pfDetail" class="cpanel">
          <h3>{{ pfDetail.profile_name }} <span class="clink" @click="pfDetail=null">收起</span></h3>
          <table>
            <tr><th>连接器</th><th>状态</th><th>到期</th></tr>
            <tr v-for="c in (pfDetail.connectors||[])" :key="c.id"><td>{{ c.title || c.id }}</td><td><span :class="pill(credKind(c.status))">{{ c.status }}</span></td><td class="cmono">{{ c.expires_at || '—' }}</td></tr>
          </table>
          <table v-if="(pfDetail.recent_errors||[]).length" style="margin-top:10px">
            <tr><th>最近错误(仅类别)</th><th>平台</th></tr>
            <tr v-for="(e,i) in pfDetail.recent_errors" :key="i"><td><span :class="pill('warn')">{{ e.category }}</span></td><td>{{ e.platform }}</td></tr>
          </table>
        </div>
      </section>

      <!-- Agent 接入 (developer) -->
      <section v-if="screen==='ingest'">
        <h1 class="ch1">Agent 接入(ingest)</h1>
        <p class="csub">同步 / 异步两种模式;key 与 owner/profile/agent 服务端绑定。owner 从你的飞书会话派生,看不到别人的。</p>
        <div class="ccards" v-if="dev">
          <div class="ccard ok"><div class="ck">我的可用 Agent</div><div class="cv">{{ (dev.agents||[]).length }} <small>个</small></div></div>
          <div class="ccard ok"><div class="ck">可用接口</div><div class="cv">{{ (dev.api_catalog||[]).length }} <small>个</small></div></div>
        </div>
        <div class="cpanel">
          <h3>我的可用 Agent</h3>
          <table v-if="(dev?.agents||[]).length"><tr><th>名称</th><th>profile</th><th>状态</th></tr>
            <tr v-for="a in dev.agents" :key="a.profile"><td>{{ a.name }}</td><td class="cmono">{{ a.profile }}</td><td><span :class="pill(a.active?'ok':'mut')">{{ a.active?'可用':'停用' }}</span></td></tr>
          </table>
          <div v-else class="cempty">你名下暂无 agent</div>
        </div>
        <div class="cpanel">
          <h3>我的 ingest key <button class="cbtn" disabled title="M3 落地">+ 生成新 key(自助 · M3)</button></h3>
          <div class="cnote">{{ dev?.key_hint }}</div>
        </div>
        <h2 class="ch2">可用接口清单 · 怎么调</h2>
        <div v-for="a in (dev?.api_catalog||[])" :key="a.path" class="cpanel">
          <h3><span :class="pill('mut')">{{ a.method }}</span> {{ a.name }} <span class="cmono csrc">{{ a.path }}</span></h3>
          <div class="ckv"><b>用途</b><span>{{ a.purpose }}</span><b>鉴权</b><span class="cmono">{{ a.auth }}</span></div>
          <pre class="ccode">{{ a.example }}</pre>
        </div>
      </section>

      <!-- 发布指引 (developer) -->
      <section v-if="screen==='guide'">
        <h1 class="ch1">发布指引</h1>
        <div class="cpanel"><h3>流程</h3><div class="ckv">
          <b>1 发布</b><span>在 AiDock 发布 skill(新 release 必须 bump version,同版本会被幂等吞掉)</span>
          <b>2 到达</b><span>webhook 自动进事件队列 → 按 audience 装机</span>
          <b>3 回执</b><span>回「我的发布物」看装机结果,失败带错误码</span>
        </div></div>
        <div class="cpanel"><h3>规范红线</h3><div class="ckv">
          <b>路径</b><span>SKILL.md 禁止硬编码绝对路径(本机路径上生产会直接失败)</span>
          <b>凭证</b><span>凭证永不随 skill 分发 — 每人自行认证</span>
          <b>环境</b><span>默认环境必须 pre,online-by-default 禁止</span>
        </div></div>
      </section>
    </main>
  </div>
</template>

<style scoped>
/* Keep 8.0 tokens (subset) — 绿 #24C789 仅主操作/成功;灰阶文本梯;扁平;半径 2/6 */
.console-shell { display: flex; min-height: 100vh; background: #F7F7F7; color: #333;
  font: 14px/1.6 "PingFang SC", "Noto Sans SC", -apple-system, sans-serif; }
.cside { width: 208px; flex: none; background: #fff; border-right: 1px solid #F2F2F2; padding: 20px 10px; display: flex; flex-direction: column; }
.cbrand { display: flex; align-items: center; gap: 8px; padding: 0 10px 20px; }
.cmark { width: 28px; height: 28px; border-radius: 6px; background: #3A3340; color: #fff; font-weight: 800; display: flex; align-items: center; justify-content: center; }
.cname { font-size: 15px; font-weight: 600; color: #000; } .cname small { display: block; font-size: 10px; color: #999; font-weight: 400; }
.cnavlab { font-size: 10px; color: #999; padding: 14px 10px 4px; } .cnavtag { font-size: 9px; color: #ccc; }
.cnav { display: block; width: 100%; text-align: left; border: 0; background: none; padding: 8px 10px; border-radius: 2px; color: #666; font: inherit; cursor: pointer; position: relative; }
.cnav:hover { background: #FAFAFA; } .cnav.on { background: #FAFAFA; color: #000; font-weight: 600; }
.cnav.on::before { content: ''; position: absolute; left: 0; top: 7px; bottom: 7px; width: 3px; border-radius: 2px; background: #24C789; }
.cfoot { margin-top: auto; padding: 10px; font-size: 11px; color: #999; border-top: 1px solid #F2F2F2; }
.crole { display: inline-block; margin-top: 6px; padding: 1px 8px; border-radius: 9px; font-size: 10px; }
.r-admin { background: #E0FDF0; color: #0E9A68; } .r-dev { background: #F2F2F2; color: #666; }
.cmain { flex: 1; min-width: 0; padding: 28px 32px; max-width: 1080px; }
.ch1 { font-size: 20px; color: #000; margin: 0 0 4px; font-weight: 600; }
.ch2 { font-size: 15px; color: #000; margin: 28px 0 10px; font-weight: 600; }
.csub { font-size: 12px; color: #999; margin: 0 0 20px; }
.ccards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 16px; }
.ccard { background: #fff; border: 1px solid #F2F2F2; border-radius: 6px; padding: 16px 18px; }
.ccard.crit { border-left: 3px solid #E63A30; } .ccard.warn { border-left: 3px solid #FEC833; } .ccard.ok { border-left: 3px solid #24C789; }
.ck { font-size: 12px; color: #666; } .cv { font-size: 30px; font-weight: 800; color: #000; font-variant-numeric: tabular-nums; margin-top: 4px; }
.cv small { font-size: 12px; font-weight: 400; color: #999; }
.cpanel { background: #fff; border: 1px solid #F2F2F2; border-radius: 6px; padding: 0 0 4px; margin-bottom: 14px; }
.cpanel h3 { font-size: 13px; margin: 0; padding: 12px 16px; border-bottom: 1px solid #F2F2F2; font-weight: 600; color: #000; }
.csrc { margin-left: 8px; font-weight: 400; color: #ccc; font-size: 11px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-size: 11px; color: #999; font-weight: 400; padding: 8px 16px; border-bottom: 1px solid #F2F2F2; }
td { padding: 10px 16px; border-bottom: 1px solid #F2F2F2; }
tr:last-child td { border-bottom: 0; }
.crow { cursor: pointer; } .crow:hover td { background: #FAFAFA; }
.cmono { font-family: ui-monospace, Menlo, monospace; font-variant-numeric: tabular-nums; }
.cempty { padding: 20px 16px; color: #999; font-size: 13px; text-align: center; }
.cerr { padding: 12px 16px; color: #E63A30; background: #FFE9E7; border-radius: 2px; margin-bottom: 14px; font-size: 13px; }
.csearch { margin-bottom: 12px; } .csearch input { width: 100%; max-width: 420px; border: 1px solid #F2F2F2; background: #fff; border-radius: 17px; padding: 8px 16px; font: inherit; outline: none; }
.pill-ok { background: #E0FDF0; color: #0E9A68; } .pill-warn { background: #FFF7DB; color: #B98A00; } .pill-crit { background: #FFE9E7; color: #E63A30; } .pill-mut { background: #F2F2F2; color: #666; }
[class^="pill-"] { display: inline-block; font-size: 11px; border-radius: 10px; padding: 1px 9px; }
.cbtn { border: 1px solid #F2F2F2; background: #FAFAFA; color: #ccc; border-radius: 15px; padding: 3px 12px; font-size: 12px; float: right; margin: -2px 0; }
.cnote { font-size: 12px; color: #666; background: #FAFAFA; border-radius: 2px; padding: 10px 14px; margin: 12px 16px; }
.ckv { display: grid; grid-template-columns: 70px 1fr; gap: 6px 14px; padding: 12px 16px; font-size: 13px; }
.ckv b { color: #999; font-weight: 400; }
.ccode { background: #FAFAFA; border: 1px solid #F2F2F2; border-radius: 2px; margin: 12px 16px; padding: 12px; font-size: 12px; overflow-x: auto; font-family: ui-monospace, Menlo, monospace; }
.clink { float: right; font-size: 12px; color: #24C789; cursor: pointer; font-weight: 400; }
@media (prefers-color-scheme: dark) {
  .console-shell { background: #0D0D0D; color: #ccc; } .cside, .ccard, .cpanel { background: #1A1A1A; border-color: #262626; }
  .cname, .cv, .cpanel h3, .ch1, .ch2 { color: #fff; } .cnav:hover, .cnav.on, .crow:hover td, .cnote, .ccode, .csearch input { background: #0D0D0D; }
  th, td { border-color: #262626; }
}
</style>
