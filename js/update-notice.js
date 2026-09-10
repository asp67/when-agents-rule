// Read version metadata only. Never execute remote markup or mutate a checkout.
const WarUpdates = {
    url: 'https://raw.githubusercontent.com/asp67/when-agents-rule/main/index.html',
    key: 'war.update-check.v1',
    ttl: 15 * 60 * 1000,
    parseBuild(html) {
        const match = String(html).match(/<script\b[^>]*\bsrc=["']js\/game\.js\?v=(\d+)["']/i);
        const build = match ? Number(match[1]) : 0;
        return Number.isSafeInteger(build) && build > 0 ? build : null;
    },
    async latest(fetcher, storage, now = Date.now()) {
        try {
            const cached = JSON.parse(storage?.getItem(this.key) || 'null');
            if (cached && Number.isFinite(cached.at) && now >= cached.at && now - cached.at < this.ttl
                && (cached.build === null || (Number.isSafeInteger(cached.build) && cached.build > 0))) return cached.build;
        } catch (_) { /* Private browsing and corrupt caches must not block play. */ }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        let build = null;
        try {
            const response = await fetcher(this.url, {signal: controller.signal, credentials: 'omit', cache: 'no-cache', referrerPolicy: 'no-referrer'});
            if (response.ok) build = this.parseBuild(await response.text());
        } catch (_) { /* Offline, throttled and blocked requests stay silent. */ }
        finally { clearTimeout(timeout); }
        try { storage?.setItem(this.key, JSON.stringify({at: now, build})); } catch (_) {}
        return build;
    }
};

if (typeof document !== 'undefined') {
    const translations = {
        en: ['Update available', 'On the computer hosting WAR, open a terminal in the repository folder (the folder containing index.html and package.json), then run:', 'Copy command', 'View changes', 'After the pull finishes, refresh with Ctrl+F5 (Mac: Cmd+Shift+R). ZIP download? Download the latest ZIP from GitHub instead.', 'Command copied.', 'Select and copy the command above.'],
        de: ['Update verfügbar', 'Öffne auf dem Computer, der WAR bereitstellt, ein Terminal im Repository-Ordner (mit index.html und package.json) und führe aus:', 'Befehl kopieren', 'Änderungen ansehen', 'Danach mit Strg+F5 neu laden (Mac: Cmd+Umschalt+R). ZIP-Download? Lade stattdessen das aktuelle ZIP von GitHub herunter.', 'Befehl kopiert.', 'Markiere und kopiere den Befehl oben.'],
        fr: ['Mise à jour disponible', 'Sur l’ordinateur qui héberge WAR, ouvrez un terminal dans le dossier du dépôt (contenant index.html et package.json), puis exécutez :', 'Copier la commande', 'Voir les modifications', 'Ensuite, actualisez avec Ctrl+F5 (Mac : Cmd+Maj+R). Installation ZIP ? Téléchargez plutôt le dernier ZIP sur GitHub.', 'Commande copiée.', 'Sélectionnez et copiez la commande ci-dessus.'],
        es: ['Actualización disponible', 'En el equipo que aloja WAR, abre una terminal en la carpeta del repositorio (con index.html y package.json) y ejecuta:', 'Copiar comando', 'Ver cambios', 'Después, recarga con Ctrl+F5 (Mac: Cmd+Mayús+R). ¿Instalación ZIP? Descarga el ZIP más reciente de GitHub.', 'Comando copiado.', 'Selecciona y copia el comando de arriba.'],
        zh: ['有可用更新', '在运行 WAR 服务的电脑上，在仓库文件夹（包含 index.html 和 package.json）中打开终端，然后运行：', '复制命令', '查看更改', '完成后按 Ctrl+F5 刷新（Mac：Cmd+Shift+R）。使用 ZIP 安装？请从 GitHub 下载最新 ZIP。', '命令已复制。', '请选择并复制上方命令。']
    };
    const keys = ['available','instructions','copy','changes','refresh','copied','manual'];
    for (const [lang, values] of Object.entries(translations)) {
        if (typeof I18N !== 'undefined' && I18N[lang]) keys.forEach((key, i) => I18N[lang]['update.' + key] = values[i]);
    }
    const start = async () => {
        const notice = document.getElementById('updateNotice');
        const current = UIManager.buildVersion();
        if (!notice || !current) return;
        let storage;
        try { storage = localStorage; } catch (_) {}
        document.getElementById('copyUpdateCommand').addEventListener('click', async () => {
            const command = document.getElementById('updateCommand');
            let copied = false;
            try { await navigator.clipboard.writeText(command.value); copied = true; } catch (_) {
                command.focus(); command.select();
                try { copied = document.execCommand('copy'); } catch (_) {}
            }
            const status = document.getElementById('updateCopyStatus');
            status.dataset.i18n = copied ? 'update.copied' : 'update.manual';
            status.textContent = t(status.dataset.i18n);
        });
        const latest = await WarUpdates.latest(window.fetch.bind(window), storage);
        if (latest > current) {
            document.getElementById('updateBuild').textContent = latest;
            applyI18n(notice);
            notice.hidden = false;
        }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
}
