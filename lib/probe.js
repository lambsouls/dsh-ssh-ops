// lib/probe.js —— 远程环境探测脚本片段与结果解析。
//
// 探测分两层：
//   ① 环境画像（OS / 内核 / 资源 / 已装服务管理器）——一条命令拿全；
//   ② 应用发现（systemd 单元、docker 容器、compose 项目、常见监听端口）。
// 解析尽量宽松：远端发行版千差万别，拿不全就返回拿得到的那部分，不编。

/** 环境画像。输出以 `##KEY##` 分段，便于在嘈杂输出里切。 */
export const ENV_SCRIPT = String.raw`
set -o pipefail
echo "##OS##"
( cat /etc/os-release 2>/dev/null | sed -n 's/^PRETTY_NAME=//p' | tr -d '"' ) || true
echo "##KERNEL##"
uname -srm 2>/dev/null || true
echo "##UPTIME##"
( uptime -p 2>/dev/null || uptime 2>/dev/null ) || true
echo "##CPU##"
( nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null ) || true
echo "##MEM##"
( free -m 2>/dev/null | awk '/^Mem:/{print $2" "$3}' ) || true
echo "##DISK##"
( df -h / 2>/dev/null | awk 'NR==2{print $2" "$3" "$5}' ) || true
echo "##INIT##"
( command -v systemctl >/dev/null && echo systemd || (command -v rc-service >/dev/null && echo openrc || echo other) ) || true
echo "##DOCKER##"
( command -v docker >/dev/null && docker --version 2>/dev/null || echo none ) || true
echo "##WHOAMI##"
( id -un 2>/dev/null; id -u 2>/dev/null ) || true
`;

/** 应用发现。每个分区都容错：没有这一套就输出空。 */
export const APP_SCRIPT = String.raw`
echo "##SYSTEMD##"
if command -v systemctl >/dev/null 2>&1; then
  # --plain 去掉失败单元前面的 ● 标记，字段就不会错位；--state=running 已经保证了状态。
  systemctl list-units --type=service --state=running --plain --no-legend --no-pager 2>/dev/null \
    | awk '{print $1}' | sed 's/\.service$//' \
    | grep -Ev '^(systemd-|dbus|ssh|sshd|cron|crond|rsyslog|syslog|getty|serial-getty|user@|polkit|udisks|networkd|resolved|logind|journald|snapd|unattended|irqbalance|ModemManager|multipathd|packagekit|containerd|docker$|chronyd|ntpd|systemd-timesyncd|blk-avail|accounts-daemon|atd|udisks2|cups|avahi-daemon|wpa_supplicant|thermald|switcheroo|rsync|nscd|upower|lvm2|apparmor|snap\.)' || true
fi
echo "##DOCKER##"
if command -v docker >/dev/null 2>&1; then
  docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}|{{.Status}}' 2>/dev/null || true
fi
echo "##COMPOSE##"
if command -v docker >/dev/null 2>&1; then
  docker ps --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | sort -u | grep -v '^$' || true
fi
echo "##PORTS##"
( (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | awk 'NR>1{print $4}' ) 2>/dev/null | sed 's/.*://' | sort -n -u | head -40 || true
echo "##SITES##"
for d in /www/wwwroot /var/www /opt/1panel/apps /opt/apps /data/www; do
  if [ -d "$d" ]; then ls -1 "$d" 2>/dev/null | head -30 | sed "s|^|$d/|"; fi
done
`;

/** 把 `##KEY##` 分段文本切成 Map。 */
export function splitSections(text) {
    const out = new Map();
    let current = null;
    for (const line of String(text ?? '').split(/\r?\n/)) {
        const m = /^##([A-Z]+)##$/.exec(line.trim());
        if (m) { current = m[1]; out.set(current, []); continue; }
        if (current) out.get(current).push(line);
    }
    return out;
}

function firstLine(section) {
    return (section ?? []).map((s) => s.trim()).find(Boolean) ?? null;
}

/** 解析环境画像。 */
export function parseEnv(stdout) {
    const s = splitSections(stdout);
    const mem = firstLine(s.get('MEM'));
    const disk = firstLine(s.get('DISK'));
    const [memTotal, memUsed] = (mem ?? '').split(/\s+/);
    const [diskTotal, diskUsed, diskPct] = (disk ?? '').split(/\s+/);
    return {
        os: firstLine(s.get('OS')),
        kernel: firstLine(s.get('KERNEL')),
        uptime: firstLine(s.get('UPTIME')),
        cpus: Number(firstLine(s.get('CPU')) ?? 0) || null,
        memoryMb: memTotal ? { total: Number(memTotal), used: Number(memUsed) } : null,
        disk: diskTotal ? { total: diskTotal, used: diskUsed, usePercent: diskPct } : null,
        init: firstLine(s.get('INIT')),
        docker: (() => {
            const v = firstLine(s.get('DOCKER'));
            return v && v !== 'none' ? v : null;
        })(),
        user: (() => {
            const lines = (s.get('WHOAMI') ?? []).map((x) => x.trim()).filter(Boolean);
            return { name: lines[0] ?? null, uid: lines[1] ?? null };
        })(),
    };
}

/** 把 `k=v` 之外的常见应用名映射到 kind。 */
const KIND_HINTS = [
    [/nginx/i, 'webserver'], [/apache|httpd/i, 'webserver'], [/caddy/i, 'webserver'],
    [/mysql|mariadb/i, 'database'], [/postgres/i, 'database'], [/redis/i, 'cache'], [/mongo/i, 'database'],
    [/docker/i, 'container'], [/openlist|alist/i, 'files'], [/emby|jellyfin|plex|navidrome/i, 'media'],
    [/qbittorrent|transmission|aria2/i, 'download'], [/1panel|baota|bt-panel/i, 'panel'],
    [/node|pm2/i, 'runtime'], [/java|tomcat/i, 'runtime'], [/python|gunicorn|uwsgi/i, 'runtime'],
    [/ssh|sshd/i, 'remote'], [/frp|cloudflared|tailscale|wireguard/i, 'tunnel'],
];

function guessKind(name, image) {
    const haystack = `${name} ${image ?? ''}`;
    for (const [re, kind] of KIND_HINTS) if (re.test(haystack)) return kind;
    return 'generic';
}

/**
 * systemd 单元分成两拨：
 *   · 认出是常见应用的 → 保留它自己的 kind；
 *   · 认不出的 → 归为 'system'（发行版/NAS 自带的基础服务）。
 * 不猜、不删：归类只是让面板能把「你装的东西」和「系统自带」分开显示。
 */
function systemUnitKind(name) {
    // 发行版 / NAS 自己的管理组件：名字像应用但其实是系统骨件。
    if (/^(trim[_-]|dockermgr$|dsmgr$|dlcenter$|accountsrv$|usersrv$|ai_manager$|resmon_service$|sysdiag$)/i.test(name)) return 'system';
    const kind = guessKind(name);
    return kind === 'generic' ? 'system' : kind;
}

/** 解析应用清单。 */
export function parseApps(stdout) {
    const s = splitSections(stdout);
    const apps = [];

    for (const raw of s.get('SYSTEMD') ?? []) {
        const service = raw.trim();
        if (!service) continue;
        if (!/^[A-Za-z0-9@._:-]+$/.test(service)) continue;
        if (/^(dbus|ssh|sshd|cron|rsyslog|polkit|udisks|networkd|resolved|logind|journald|getty|snapd|unattended)/.test(service)) continue;
        apps.push({
            name: service,
            kind: systemUnitKind(service),
            manager: 'systemd',
            service,
            running: true,
            port: null,
            notes: null,
        });
    }

    for (const raw of s.get('DOCKER') ?? []) {
        const line = raw.trim();
        if (!line || !line.includes('|')) continue;
        const [name, image, ports, status] = line.split('|');
        const portMatch = /(\d+)->(\d+)/.exec(ports ?? '');
        apps.push({
            name: (name ?? '').trim(),
            kind: guessKind(name ?? '', image ?? ''),
            manager: 'docker',
            service: (name ?? '').trim(),
            running: /up/i.test(status ?? ''),
            port: portMatch ? Number(portMatch[1]) : null,
            notes: [image ? `镜像 ${image.trim()}` : null, status ? status.trim() : null].filter(Boolean).join(' · ') || null,
        });
    }

    // compose 项目：容器已经按名字列过了，这里只补「项目」这一层视图。
    // 有同名容器的 compose 项目不再另立一条，否则面板上会出现两行一样的名字。
    const containerNames = new Set(apps.filter((a) => a.manager === 'docker').map((a) => a.name));
    const projects = (s.get('COMPOSE') ?? []).map((x) => x.trim()).filter((p) => p && !containerNames.has(p));
    // 一容器一 compose 项目的场景（常见于单容器栈）：项目名等于容器名时不算新应用，
    // 直接把 manager 标成 docker-compose，让后续 app_control 知道该用 compose 命令。
    const composeAll = new Set((s.get('COMPOSE') ?? []).map((x) => x.trim()).filter(Boolean));
    for (const app of apps) {
        if (app.manager === 'docker' && composeAll.has(app.name)) app.manager = 'docker-compose';
    }
    for (const project of projects) {
        apps.push({ name: project, kind: 'compose', manager: 'docker-compose', service: project, running: true, port: null, notes: 'docker compose 项目' });
    }

    const ports = (s.get('PORTS') ?? []).map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
    const sites = (s.get('SITES') ?? []).map((x) => x.trim()).filter(Boolean);

    return { apps: dedupe(apps), listeningPorts: [...new Set(ports)], siteDirs: [...new Set(sites)] };
}

function dedupe(list) {
    const seen = new Map();
    for (const app of list) {
        const key = `${app.manager}::${app.service}`;
        if (!seen.has(key)) seen.set(key, app);
    }
    return [...seen.values()];
}

/** 应用管理命令（只生成字符串，不执行）。 */
export function appCommand(app, action, extra) {
    const manager = app.manager ?? 'systemd';
    const service = app.service ?? app.name;
    if (manager === 'docker') {
        switch (action) {
            case 'status': return `docker inspect -f '{{.State.Status}} · restarts={{.RestartCount}} · image={{.Config.Image}}' ${shellQuote(service)}`;
            case 'start': return `docker start ${shellQuote(service)}`;
            case 'stop': return `docker stop ${shellQuote(service)}`;
            case 'restart': return `docker restart ${shellQuote(service)}`;
            case 'logs': return `docker logs --tail ${Number(extra?.lines ?? 120)} --timestamps ${shellQuote(service)} 2>&1`;
            case 'reload': return `docker kill -s HUP ${shellQuote(service)}`;
            default: throw new Error(`docker 不支持的动作：${action}`);
        }
    }
    if (manager === 'docker-compose') {
        const dir = extra?.composeDir;
        if (!dir) throw new Error('docker-compose 动作需要 composeDir');
        const base = `cd ${shellQuote(dir)} && docker compose`;
        switch (action) {
            case 'status': return `${base} ps`;
            case 'start': return `${base} start`;
            case 'stop': return `${base} stop`;
            case 'restart': return `${base} restart`;
            case 'logs': return `${base} logs --tail ${Number(extra?.lines ?? 120)} --timestamps`;
            case 'reload': return `${base} up -d`;
            default: throw new Error(`compose 不支持的动作：${action}`);
        }
    }
    const unit = service.endsWith('.service') ? service : `${service}.service`;
    switch (action) {
        case 'status': return `systemctl status ${shellQuote(unit)} --no-pager --lines=0; systemctl is-active ${shellQuote(unit)}`;
        case 'start': return `systemctl start ${shellQuote(unit)} && sleep 1 && systemctl is-active ${shellQuote(unit)}`;
        case 'stop': return `systemctl stop ${shellQuote(unit)} && sleep 1 && systemctl is-active ${shellQuote(unit)}`;
        case 'restart': return `systemctl restart ${shellQuote(unit)} && sleep 1 && systemctl is-active ${shellQuote(unit)}`;
        case 'reload': return `systemctl reload ${shellQuote(unit)} 2>/dev/null || systemctl restart ${shellQuote(unit)}; sleep 1; systemctl is-active ${shellQuote(unit)}`;
        case 'logs': return `journalctl -u ${shellQuote(unit)} -n ${Number(extra?.lines ?? 120)} --no-pager -o short-iso`;
        default: throw new Error(`systemd 不支持的动作：${action}`);
    }
}

export function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
