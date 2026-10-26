(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};

  const STATUS = [
    ['aberto', 'Aberto'],
    ['progresso', 'Em progresso'],
    ['teste', 'Em teste'],
    ['resolvido', 'Resolvido'],
    ['nao-corrigir', 'Não corrigir'],
  ];
  const PRIO = [
    ['critica', 'Crítica'],
    ['alta', 'Alta'],
    ['media', 'Média'],
    ['baixa', 'Baixa'],
  ];
  const FREQ = [
    ['', 'Não indicada'],
    ['sempre', 'Sempre (100%)'],
    ['frequente', 'Frequente'],
    ['as-vezes', 'Às vezes'],
    ['raro', 'Raro'],
    ['uma-vez', 'Aconteceu uma vez'],
  ];
  const FREQ_SHORT = {
    '': '',
    sempre: 'Sempre',
    frequente: 'Frequente',
    'as-vezes': 'Às vezes',
    raro: 'Raro',
    'uma-vez': '1 vez',
  };
  const PLATFORMS = ['Windows', 'macOS', 'Linux', 'PlayStation', 'Xbox', 'Switch', 'Android', 'iOS', 'Web'];

  const STATUS_LABEL = Object.fromEntries(STATUS);
  const PRIO_LABEL = Object.fromEntries(PRIO);
  const FREQ_LABEL = Object.fromEntries(FREQ);
  const PRIO_ORDER = { critica: 0, alta: 1, media: 2, baixa: 3 };
  const STATUS_ORDER = { aberto: 0, progresso: 1, teste: 2, resolvido: 3, 'nao-corrigir': 4 };
  const CLOSED = ['resolvido', 'nao-corrigir'];

  const FIELD_LABEL = {
    created: 'Criado',
    title: 'Título',
    status: 'Estado',
    priority: 'Prioridade',
    area: 'Área',
    version: 'Versão / build',
    frequency: 'Frequência',
    platform: 'Plataforma',
    labels: 'Etiquetas',
    description: 'Descrição',
    steps: 'Passos para reproduzir',
    expected: 'Comportamento esperado',
    actual: 'Comportamento observado',
    attachments: 'Anexos',
  };
  const LONG_FIELDS = ['description', 'steps', 'expected', 'actual'];
  const MAX_FILE_BYTES = 50 * 1024 * 1024;

  let state = { version: 1, nextId: 1, bugs: [] };
  let baseUri = '';
  let loadError = null;
  let view = saved.view === 'kanban' ? 'kanban' : 'table';
  let sort = { key: 'id', dir: 'desc' };
  let filters = { q: '', status: '', prio: '', label: '', hideClosed: false };
  let selected = new Set();
  let modal = null;
  let viewerEl = null;
  let pendingDelete = null; // id | 'bulk'
  let deleteTimer = null;
  let dragId = null;
  let reqCounter = 0;
  const pendingReqs = new Map();

  const app = document.getElementById('app');
  let statsEl, mainEl, bulkEl, quickInput, labelFilter, labelList, viewButtons;

  // ---------- helpers ----------
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'text') node.textContent = v;
        else if (k === 'value') node.value = v;
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, v);
      }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  const fmtId = (id) => 'BUG-' + String(id).padStart(3, '0');
  const now = () => new Date().toISOString();
  const arr = (x) => (Array.isArray(x) ? x : []);

  function fmtDate(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d)) return '';
    return d.toLocaleDateString('pt-PT', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function fmtDateTime(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d)) return '';
    return d.toLocaleString('pt-PT', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function labelHue(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return h;
  }

  function chip(name, onremove) {
    return el(
      'span',
      { class: 'chip', style: '--h:' + labelHue(name) },
      name,
      onremove
        ? el('button', { class: 'chip-x', title: 'Remover', text: '×', onclick: (e) => { e.stopPropagation(); onremove(); } })
        : null
    );
  }

  function uniqLabels(list) {
    const out = [];
    for (const raw of list) {
      const s = String(raw).trim();
      if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
    }
    return out;
  }

  function allLabels() {
    const set = new Map();
    for (const b of state.bugs) for (const l of b.labels) if (!set.has(l.toLowerCase())) set.set(l.toLowerCase(), l);
    return [...set.values()].sort((a, b) => a.localeCompare(b, 'pt'));
  }

  function attachmentUrl(path) {
    return baseUri + '/' + path.split('/').map(encodeURIComponent).join('/');
  }

  function normalizeBug(b) {
    return {
      ...b,
      id: b.id,
      title: String(b.title || ''),
      description: String(b.description || ''),
      steps: String(b.steps || ''),
      expected: String(b.expected || ''),
      actual: String(b.actual || ''),
      area: String(b.area || ''),
      version: String(b.version || ''),
      platform: String(b.platform || ''),
      frequency: Object.prototype.hasOwnProperty.call(FREQ_LABEL, b.frequency) ? b.frequency : '',
      status: STATUS_LABEL[b.status] ? b.status : 'aberto',
      priority: PRIO_LABEL[b.priority] ? b.priority : 'media',
      labels: uniqLabels(arr(b.labels)),
      attachments: arr(b.attachments)
        .filter((a) => a && typeof a.path === 'string')
        .map((a) => ({ name: String(a.name || a.path), path: a.path, kind: a.kind === 'video' ? 'video' : 'image' })),
      history: arr(b.history)
        .filter((h) => h && h.at && h.field)
        .map((h) => ({ at: h.at, field: String(h.field), from: h.from, to: h.to, note: h.note })),
      createdAt: b.createdAt || now(),
      updatedAt: b.updatedAt || b.createdAt || now(),
    };
  }

  function findBug(id) {
    return state.bugs.find((b) => b.id === id);
  }

  function display(field, v) {
    if (field === 'status') return STATUS_LABEL[v] || String(v);
    if (field === 'priority') return PRIO_LABEL[v] || String(v);
    if (field === 'frequency') return FREQ_LABEL[v] || '—';
    return v === '' || v === undefined || v === null ? '—' : String(v);
  }

  // Aplica alterações a um bug e regista o histórico. Devolve true se algo mudou.
  function patchBug(bug, fields) {
    const at = now();
    const entries = [];
    for (const [k, v] of Object.entries(fields)) {
      const old = bug[k];
      if (k === 'labels') {
        if (arr(old).join('\u0000') === v.join('\u0000')) continue;
        entries.push({ at, field: k, from: arr(old).join(', ') || '—', to: v.join(', ') || '—' });
      } else if (k === 'attachments') {
        const oldPaths = new Set(arr(old).map((x) => x.path));
        const newPaths = new Set(v.map((x) => x.path));
        const added = v.filter((x) => !oldPaths.has(x.path));
        const removed = arr(old).filter((x) => !newPaths.has(x.path));
        if (!added.length && !removed.length) continue;
        for (const a of added) entries.push({ at, field: k, to: '+ ' + a.name });
        for (const r of removed) entries.push({ at, field: k, from: '− ' + r.name });
      } else if (old === v) {
        continue;
      } else if (LONG_FIELDS.includes(k)) {
        entries.push({ at, field: k, note: 'alterado' });
      } else {
        entries.push({ at, field: k, from: display(k, old), to: display(k, v) });
      }
      bug[k] = v;
    }
    if (!entries.length) return false;
    bug.updatedAt = at;
    bug.history = arr(bug.history).concat(entries).slice(-200);
    return true;
  }

  function commit() {
    vscode.postMessage({ type: 'update', data: state });
    renderAll();
  }

  // ---------- ações ----------
  function addBug(fields) {
    const t = now();
    const bug = normalizeBug({
      id: state.nextId,
      status: 'aberto',
      priority: 'media',
      createdAt: t,
      updatedAt: t,
      history: [{ at: t, field: 'created', note: 'Bug criado' }],
      ...fields,
    });
    state.nextId += 1;
    state.bugs.push(bug);
    commit();
  }

  function updateBug(id, fields) {
    const bug = findBug(id);
    if (bug && patchBug(bug, fields)) commit();
    else renderAll();
  }

  function removeBug(id) {
    state.bugs = state.bugs.filter((b) => b.id !== id);
    selected.delete(id);
    pendingDelete = null;
    commit();
  }

  function bulkApply(fn) {
    let changed = false;
    for (const b of state.bugs) {
      if (selected.has(b.id) && patchBug(b, fn(b))) changed = true;
    }
    if (changed) commit();
    else renderBulk();
  }

  function bulkDelete() {
    state.bugs = state.bugs.filter((b) => !selected.has(b.id));
    selected.clear();
    pendingDelete = null;
    commit();
  }

  function askDelete(id) {
    pendingDelete = id;
    clearTimeout(deleteTimer);
    deleteTimer = setTimeout(() => {
      pendingDelete = null;
      renderAll();
    }, 4000);
    renderAll();
  }

  function toggleSelect(id, on) {
    if (on) selected.add(id);
    else selected.delete(id);
    renderBulk();
    renderMain();
  }

  function setView(v) {
    view = v;
    vscode.setState({ view });
    renderViewButtons();
    renderMain();
  }

  function request(msg) {
    return new Promise((resolve) => {
      const reqId = ++reqCounter;
      pendingReqs.set(reqId, resolve);
      vscode.postMessage({ ...msg, reqId });
    });
  }

  // ---------- filtros e ordenação ----------
  function visibleBugs() {
    const q = filters.q.trim().toLowerCase();
    const list = state.bugs.filter((b) => {
      if (filters.status && b.status !== filters.status) return false;
      if (filters.prio && b.priority !== filters.prio) return false;
      if (filters.label && !b.labels.includes(filters.label)) return false;
      if (filters.hideClosed && CLOSED.includes(b.status)) return false;
      if (q) {
        const hay = [fmtId(b.id), b.title, b.description, b.steps, b.expected, b.actual, b.area, b.version, b.platform, b.labels.join(' ')]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const dir = sort.dir === 'asc' ? 1 : -1;
    return list.sort((a, b) => {
      let r = 0;
      switch (sort.key) {
        case 'id': r = a.id - b.id; break;
        case 'title': r = a.title.localeCompare(b.title, 'pt'); break;
        case 'status': r = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]; break;
        case 'priority': r = PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority]; break;
        case 'area': r = a.area.localeCompare(b.area, 'pt'); break;
        case 'updatedAt': r = (a.updatedAt || '').localeCompare(b.updatedAt || ''); break;
      }
      if (r === 0) r = a.id - b.id;
      return r * dir;
    });
  }

  // ---------- estrutura base ----------
  function buildShell() {
    app.textContent = '';

    statsEl = el('div', { class: 'stats' });
    viewButtons = {
      table: el('button', { class: 'seg', text: 'Tabela', onclick: () => setView('table') }),
      kanban: el('button', { class: 'seg', text: 'Kanban', onclick: () => setView('kanban') }),
    };
    const header = el(
      'div',
      { class: 'header' },
      el('div', { class: 'header-left' }, el('h1', { text: 'Bugs' }), el('div', { class: 'segmented' }, viewButtons.table, viewButtons.kanban)),
      statsEl
    );

    quickInput = el('input', {
      type: 'text',
      class: 'quick-add',
      placeholder: 'Título de um novo bug… (Enter para adicionar)',
      onkeydown: (e) => {
        if (e.key === 'Enter' && quickInput.value.trim()) {
          addBug({ title: quickInput.value.trim() });
          quickInput.value = '';
        }
      },
    });

    const search = el('input', {
      type: 'search',
      class: 'search',
      placeholder: 'Pesquisar…',
      oninput: (e) => { filters.q = e.target.value; renderMain(); },
    });

    const statusFilter = el(
      'select',
      { onchange: (e) => setStatusFilter(e.target.value) },
      el('option', { value: '', text: 'Todos os estados' }),
      STATUS.map(([v, l]) => el('option', { value: v, text: l }))
    );
    statusFilter.id = 'statusFilter';

    const prioFilter = el(
      'select',
      { onchange: (e) => { filters.prio = e.target.value; renderMain(); } },
      el('option', { value: '', text: 'Todas as prioridades' }),
      PRIO.map(([v, l]) => el('option', { value: v, text: l }))
    );

    labelFilter = el('select', { onchange: (e) => { filters.label = e.target.value; renderMain(); } });

    const hideClosed = el('input', {
      type: 'checkbox',
      id: 'hideClosed',
      onchange: (e) => { filters.hideClosed = e.target.checked; renderMain(); },
    });

    const toolbar = el(
      'div',
      { class: 'toolbar' },
      quickInput,
      search,
      statusFilter,
      prioFilter,
      labelFilter,
      el('label', { class: 'check-label' }, hideClosed, 'Esconder fechados'),
      el('button', { class: 'btn-primary', onclick: () => openModal(null), text: '+ Novo bug' })
    );

    bulkEl = el('div', { class: 'bulkbar hidden' });
    mainEl = el('div', { class: 'main' });
    labelList = el('datalist', { id: 'labelList' });
    const platformList = el('datalist', { id: 'platformList' }, PLATFORMS.map((p) => el('option', { value: p })));

    app.append(header, toolbar, bulkEl, mainEl, labelList, platformList);
  }

  function renderAll() {
    if (!mainEl) return;
    renderViewButtons();
    renderStats();
    renderLabelFilter();
    renderBulk();
    renderMain();
  }

  function renderViewButtons() {
    if (!viewButtons) return;
    viewButtons.table.className = 'seg' + (view === 'table' ? ' active' : '');
    viewButtons.kanban.className = 'seg' + (view === 'kanban' ? ' active' : '');
  }

  function renderStats() {
    if (!statsEl) return;
    statsEl.textContent = '';
    statsEl.appendChild(
      el(
        'div',
        { class: 'stat' + (filters.status === '' ? ' active' : ''), onclick: () => setStatusFilter('') },
        el('b', { text: String(state.bugs.length) }),
        'Total'
      )
    );
    for (const [v, l] of STATUS) {
      const count = state.bugs.filter((b) => b.status === v).length;
      statsEl.appendChild(
        el(
          'div',
          {
            class: 'stat s-' + v + (filters.status === v ? ' active' : ''),
            onclick: () => setStatusFilter(filters.status === v ? '' : v),
          },
          el('span', { class: 'dot', style: 'background:currentColor' }),
          el('span', { class: 'stat-text' }, el('b', { text: String(count) }), ' ' + l)
        )
      );
    }
  }

  function setStatusFilter(v) {
    filters.status = v;
    const sel = document.getElementById('statusFilter');
    if (sel) sel.value = v;
    renderStats();
    renderMain();
  }

  function renderLabelFilter() {
    if (!labelFilter) return;
    const labels = allLabels();
    if (filters.label && !labels.includes(filters.label)) filters.label = '';
    labelFilter.textContent = '';
    labelFilter.appendChild(el('option', { value: '', text: 'Todas as etiquetas' }));
    for (const l of labels) labelFilter.appendChild(el('option', { value: l, text: l }));
    labelFilter.value = filters.label;
    labelList.textContent = '';
    for (const l of labels) labelList.appendChild(el('option', { value: l }));
  }

  // ---------- edição em massa ----------
  function renderBulk() {
    if (!bulkEl) return;
    for (const id of [...selected]) if (!findBug(id)) selected.delete(id);
    bulkEl.textContent = '';
    if (selected.size === 0) {
      bulkEl.className = 'bulkbar hidden';
      return;
    }
    bulkEl.className = 'bulkbar';

    const statusSel = el(
      'select',
      { onchange: (e) => { const v = e.target.value; if (v) bulkApply(() => ({ status: v })); } },
      el('option', { value: '', text: 'Mudar estado…' }),
      STATUS.map(([v, l]) => el('option', { value: v, text: l }))
    );
    const prioSel = el(
      'select',
      { onchange: (e) => { const v = e.target.value; if (v) bulkApply(() => ({ priority: v })); } },
      el('option', { value: '', text: 'Mudar prioridade…' }),
      PRIO.map(([v, l]) => el('option', { value: v, text: l }))
    );
    const addLabel = el('input', {
      type: 'text',
      list: 'labelList',
      placeholder: 'Adicionar etiqueta… (Enter)',
      onkeydown: (e) => {
        if (e.key !== 'Enter') return;
        const name = addLabel.value.trim();
        if (!name) return;
        bulkApply((b) => ({ labels: uniqLabels([...b.labels, name]) }));
      },
    });

    const present = [];
    for (const b of state.bugs) if (selected.has(b.id)) for (const l of b.labels) if (!present.includes(l)) present.push(l);
    const removeSel = present.length
      ? el(
          'select',
          { onchange: (e) => { const v = e.target.value; if (v) bulkApply((b) => ({ labels: b.labels.filter((l) => l !== v) })); } },
          el('option', { value: '', text: 'Remover etiqueta…' }),
          present.sort((a, b) => a.localeCompare(b, 'pt')).map((l) => el('option', { value: l, text: l }))
        )
      : null;

    let del;
    if (pendingDelete === 'bulk') {
      del = el(
        'span',
        { class: 'confirm' },
        'Apagar ' + selected.size + (selected.size === 1 ? ' bug?' : ' bugs?'),
        el('button', { class: 'btn-danger', text: 'Sim', onclick: bulkDelete }),
        el('button', { class: 'btn-secondary', text: 'Não', onclick: () => { pendingDelete = null; renderBulk(); } })
      );
    } else {
      del = el('button', {
        class: 'btn-secondary',
        text: 'Apagar',
        onclick: () => {
          pendingDelete = 'bulk';
          clearTimeout(deleteTimer);
          deleteTimer = setTimeout(() => { pendingDelete = null; renderBulk(); }, 4000);
          renderBulk();
        },
      });
    }

    const parts = [
      el('b', { class: 'bulk-count', text: selected.size + (selected.size === 1 ? ' selecionado' : ' selecionados') }),
      statusSel,
      prioSel,
      addLabel,
      removeSel,
      del,
      el('button', { class: 'btn-secondary', text: 'Limpar seleção', onclick: () => { selected.clear(); renderBulk(); renderMain(); } }),
    ].filter(Boolean);
    for (const p of parts) bulkEl.appendChild(p);
  }

  // ---------- vista principal ----------
  function renderMain() {
    if (!mainEl) return;
    mainEl.textContent = '';
    if (state.bugs.length === 0) {
      mainEl.appendChild(
        el('div', { class: 'table-wrap' }, el('div', { class: 'empty', text: 'Ainda não há bugs. Escreve um título acima e prime Enter para adicionar o primeiro.' }))
      );
      return;
    }
    if (view === 'kanban') renderKanban();
    else renderTable();
  }

  function attachBadge(b) {
    return b.attachments.length ? el('span', { class: 'att-count', title: b.attachments.length + ' anexo(s)', text: '📎 ' + b.attachments.length }) : null;
  }

  function renderTable() {
    const list = visibleBugs();
    const wrap = el('div', { class: 'table-wrap' });
    mainEl.appendChild(wrap);

    if (list.length === 0) {
      wrap.appendChild(el('div', { class: 'empty', text: 'Nenhum bug corresponde aos filtros.' }));
      return;
    }

    const allSelected = list.every((b) => selected.has(b.id));
    const someSelected = list.some((b) => selected.has(b.id));
    const headCheck = el('input', {
      type: 'checkbox',
      title: 'Selecionar todos os visíveis',
      checked: allSelected,
      onchange: (e) => {
        for (const b of list) {
          if (e.target.checked) selected.add(b.id);
          else selected.delete(b.id);
        }
        renderBulk();
        renderMain();
      },
    });
    headCheck.indeterminate = someSelected && !allSelected;

    const cols = [
      ['id', 'ID'],
      ['title', 'Bug'],
      ['status', 'Estado'],
      ['priority', 'Prioridade'],
      ['area', 'Área'],
      [null, 'Repro'],
      ['updatedAt', 'Atualizado'],
    ];
    const headRow = el('tr', null, el('th', { class: 'col-check' }, headCheck));
    for (const [key, label] of cols) {
      if (!key) {
        headRow.appendChild(el('th', { text: label }));
        continue;
      }
      const arrow = sort.key === key ? (sort.dir === 'asc' ? '▲' : '▼') : '';
      headRow.appendChild(
        el(
          'th',
          {
            class: 'sortable',
            onclick: () => {
              if (sort.key === key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
              else sort = { key, dir: key === 'updatedAt' || key === 'id' ? 'desc' : 'asc' };
              renderMain();
            },
          },
          label,
          el('span', { class: 'arrow', text: arrow })
        )
      );
    }
    headRow.appendChild(el('th'));

    const tbody = el('tbody');
    for (const b of list) {
      const closed = CLOSED.includes(b.status);

      const statusSel = el(
        'select',
        {
          class: 'status-select s-' + b.status,
          onclick: (e) => e.stopPropagation(),
          onchange: (e) => updateBug(b.id, { status: e.target.value }),
        },
        STATUS.map(([v, l]) => el('option', { value: v, text: l, selected: v === b.status }))
      );

      let actions;
      if (pendingDelete === b.id) {
        actions = el(
          'span',
          { class: 'confirm' },
          'Apagar?',
          el('button', { class: 'btn-danger', text: 'Sim', onclick: (e) => { e.stopPropagation(); removeBug(b.id); } }),
          el('button', { class: 'btn-secondary', text: 'Não', onclick: (e) => { e.stopPropagation(); pendingDelete = null; renderMain(); } })
        );
      } else {
        actions = [
          el('button', { class: 'icon-btn', title: 'Editar', text: '✎', onclick: (e) => { e.stopPropagation(); openModal(b.id); } }),
          el('button', { class: 'icon-btn', title: 'Apagar', text: '🗑', onclick: (e) => { e.stopPropagation(); askDelete(b.id); } }),
        ];
      }

      const check = el('input', {
        type: 'checkbox',
        checked: selected.has(b.id),
        onclick: (e) => e.stopPropagation(),
        onchange: (e) => toggleSelect(b.id, e.target.checked),
      });

      tbody.appendChild(
        el(
          'tr',
          { class: (closed ? 'done ' : '') + (selected.has(b.id) ? 'selected' : ''), onclick: () => openModal(b.id) },
          el('td', { class: 'col-check' }, check),
          el('td', { class: 'col-id', text: fmtId(b.id) }),
          el(
            'td',
            null,
            el('div', { class: 'title-row' }, el('span', { class: 'title', text: b.title || '(sem título)' }), attachBadge(b)),
            b.description ? el('div', { class: 'sub', text: b.description.split('\n')[0] }) : null,
            b.labels.length ? el('div', { class: 'chips' }, b.labels.map((l) => chip(l))) : null
          ),
          el('td', null, statusSel),
          el('td', null, el('span', { class: 'badge p-' + b.priority, text: PRIO_LABEL[b.priority] })),
          el('td', { text: b.area }),
          el('td', { class: 'col-repro', text: [FREQ_SHORT[b.frequency], b.platform].filter(Boolean).join(' · ') }),
          el('td', { class: 'col-date', text: fmtDate(b.updatedAt) }),
          el('td', { class: 'col-actions' }, actions)
        )
      );
    }

    wrap.appendChild(el('table', null, el('thead', null, headRow), tbody));
  }

  function renderKanban() {
    const list = visibleBugs();
    const board = el('div', { class: 'kanban' });
    const statuses = STATUS.filter(([v]) => !(filters.hideClosed && CLOSED.includes(v)));

    for (const [status, label] of statuses) {
      const items = list
        .filter((b) => b.status === status)
        .sort((a, b) => PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority] || a.id - b.id);

      const body = el('div', { class: 'col-body' });
      if (items.length === 0) body.appendChild(el('div', { class: 'col-empty', text: 'Sem bugs' }));
      for (const b of items) body.appendChild(buildCard(b));

      const add = el('input', {
        type: 'text',
        class: 'col-add',
        placeholder: '+ Adicionar…',
        onkeydown: (e) => {
          if (e.key === 'Enter' && add.value.trim()) {
            addBug({ title: add.value.trim(), status });
            add.value = '';
          }
        },
      });

      const col = el(
        'div',
        {
          class: 'column',
          'data-status': status,
          ondragover: (e) => { if (dragId === null) return; e.preventDefault(); col.classList.add('over'); },
          ondragleave: (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); },
          ondrop: (e) => {
            e.preventDefault();
            col.classList.remove('over');
            if (dragId === null) return;
            const ids = selected.has(dragId) && selected.size > 1 ? [...selected] : [dragId];
            dragId = null;
            let changed = false;
            for (const id of ids) {
              const bug = findBug(id);
              if (bug && patchBug(bug, { status })) changed = true;
            }
            if (changed) commit();
            else renderMain();
          },
        },
        el(
          'div',
          { class: 'col-head s-' + status },
          el('span', { class: 'dot', style: 'background:currentColor' }),
          el('span', { class: 'col-title', text: label }),
          el('span', { class: 'col-count', text: String(items.length) })
        ),
        body,
        add
      );
      board.appendChild(col);
    }
    mainEl.appendChild(board);
  }

  function buildCard(b) {
    const check = el('input', {
      type: 'checkbox',
      class: 'card-check',
      checked: selected.has(b.id),
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => toggleSelect(b.id, e.target.checked),
    });
    const meta = [b.area, FREQ_SHORT[b.frequency], b.platform].filter(Boolean).join(' · ');
    return el(
      'div',
      {
        class: 'card pr-' + b.priority + (selected.has(b.id) ? ' selected' : '') + (CLOSED.includes(b.status) ? ' done' : ''),
        draggable: 'true',
        ondragstart: (e) => {
          dragId = b.id;
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', String(b.id)); } catch { /* ignore */ }
          }
        },
        ondragend: () => { dragId = null; },
        onclick: () => openModal(b.id),
      },
      el(
        'div',
        { class: 'card-top' },
        check,
        el('span', { class: 'card-id', text: fmtId(b.id) }),
        el('span', { class: 'badge p-' + b.priority, text: PRIO_LABEL[b.priority] })
      ),
      el('div', { class: 'card-title', text: b.title || '(sem título)' }),
      b.labels.length ? el('div', { class: 'chips' }, b.labels.map((l) => chip(l))) : null,
      meta || b.attachments.length ? el('div', { class: 'card-meta' }, el('span', { text: meta }), attachBadge(b)) : null
    );
  }

  // ---------- diálogo de edição ----------
  function blankDraft(title) {
    return {
      title: title || '', description: '', steps: '', expected: '', actual: '',
      area: '', version: '', platform: '', frequency: '',
      status: 'aberto', priority: 'media', labels: [], attachments: [],
    };
  }

  function openModal(id) {
    const bug = id === null ? null : findBug(id);
    let d;
    if (bug) {
      d = {
        title: bug.title, description: bug.description, steps: bug.steps, expected: bug.expected, actual: bug.actual,
        area: bug.area, version: bug.version, platform: bug.platform, frequency: bug.frequency,
        status: bug.status, priority: bug.priority,
        labels: bug.labels.slice(), attachments: bug.attachments.map((a) => ({ ...a })),
      };
    } else {
      d = blankDraft(quickInput ? quickInput.value.trim() : '');
      if (quickInput) quickInput.value = '';
    }
    modal = { id: bug ? bug.id : null, draft: d, initial: JSON.stringify(d), tab: 'detalhes', discardAsk: false, uploading: 0, note: '' };
    renderModal();
  }

  function closeModal() {
    modal = null;
    const old = document.getElementById('modal-root');
    if (old) old.remove();
  }

  function isDirty() {
    return modal && JSON.stringify(modal.draft) !== modal.initial;
  }

  function requestClose() {
    if (!modal) return;
    if (!isDirty()) {
      closeModal();
      return;
    }
    modal.discardAsk = true;
    renderModal();
  }

  function saveModal() {
    if (!modal) return;
    const d = modal.draft;
    if (modal.uploading > 0) {
      modal.note = 'A anexar ficheiros… espera um momento.';
      updateAttachNote();
      return;
    }
    if (!d.title.trim()) {
      if (modal.tab !== 'detalhes') {
        modal.tab = 'detalhes';
        renderModal();
      }
      const t = document.getElementById('f-title');
      if (t) {
        t.focus();
        t.style.borderColor = 'var(--c-aberto)';
      }
      return;
    }
    const fields = {
      title: d.title.trim(),
      description: d.description,
      steps: d.steps,
      expected: d.expected,
      actual: d.actual,
      area: d.area.trim(),
      version: d.version.trim(),
      platform: d.platform.trim(),
      frequency: d.frequency,
      status: d.status,
      priority: d.priority,
      labels: uniqLabels(d.labels),
      attachments: d.attachments.map((a) => ({ ...a })),
    };
    if (modal.id === null) {
      addBug(fields);
    } else {
      const bug = findBug(modal.id);
      if (bug && patchBug(bug, fields)) commit();
    }
    closeModal();
  }

  function field(label, input, cls) {
    return el('div', { class: 'field' + (cls ? ' ' + cls : '') }, el('label', { text: label }), input);
  }

  function updateAttachNote() {
    const n = document.getElementById('attach-note');
    if (n) n.textContent = modal ? modal.note : '';
  }

  function renderModal() {
    const old = document.getElementById('modal-root');
    const prevScroll = old ? old.scrollTop : 0;
    if (old) old.remove();
    if (!modal) return;

    const isNew = modal.id === null;
    const bug = isNew ? null : findBug(modal.id);

    const tabs = el(
      'div',
      { class: 'tabs' },
      el('button', {
        class: 'tab' + (modal.tab === 'detalhes' ? ' active' : ''),
        text: 'Detalhes',
        onclick: () => { modal.tab = 'detalhes'; renderModal(); },
      }),
      !isNew
        ? el('button', {
            class: 'tab' + (modal.tab === 'historico' ? ' active' : ''),
            text: 'Histórico (' + (bug ? bug.history.length : 0) + ')',
            onclick: () => { modal.tab = 'historico'; renderModal(); },
          })
        : null
    );

    const banner = modal.discardAsk
      ? el(
          'div',
          { class: 'banner' },
          'Tens alterações por guardar. Descartar?',
          el('button', { class: 'btn-danger', text: 'Descartar', onclick: closeModal }),
          el('button', { class: 'btn-secondary', text: 'Continuar a editar', onclick: () => { modal.discardAsk = false; renderModal(); } })
        )
      : null;

    const body = modal.tab === 'historico' && bug ? buildHistory(bug) : buildDetails();

    const footer = el(
      'div',
      { class: 'modal-actions' },
      el('span', { class: 'meta', text: bug ? 'Criado em ' + fmtDate(bug.createdAt) : '' }),
      el('button', { class: 'btn-secondary', text: 'Cancelar', onclick: requestClose }),
      el('button', { class: 'btn-primary', text: isNew ? 'Adicionar' : 'Guardar', onclick: saveModal })
    );

    const root = el(
      'div',
      { id: 'modal-root', class: 'overlay' },
      el(
        'div',
        { class: 'modal' },
        el(
          'div',
          { class: 'modal-head' },
          el('h2', { text: isNew ? 'Novo bug' : fmtId(modal.id) }),
          el('button', { class: 'icon-btn', title: 'Fechar', text: '✕', onclick: requestClose })
        ),
        banner,
        tabs,
        body,
        footer
      )
    );

    root.addEventListener('paste', onPaste);
    root.addEventListener('dragover', (e) => {
      if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) e.preventDefault();
    });
    root.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        e.preventDefault();
        handleFiles([...e.dataTransfer.files]);
      }
    });

    document.body.appendChild(root);
    root.scrollTop = prevScroll;
    const t = document.getElementById('f-title');
    if (t && !prevScroll && !modal.discardAsk) t.focus();
  }

  function buildDetails() {
    const d = modal.draft;

    const titleInput = el('input', { id: 'f-title', type: 'text', value: d.title, placeholder: 'Resumo curto do bug', oninput: (e) => { d.title = e.target.value; e.target.style.borderColor = ''; } });
    const statusSel = el('select', { onchange: (e) => (d.status = e.target.value) }, STATUS.map(([v, l]) => el('option', { value: v, text: l, selected: v === d.status })));
    const prioSel = el('select', { onchange: (e) => (d.priority = e.target.value) }, PRIO.map(([v, l]) => el('option', { value: v, text: l, selected: v === d.priority })));
    const areaInput = el('input', { type: 'text', value: d.area, placeholder: 'Ex.: Menu, Combate, Áudio…', oninput: (e) => (d.area = e.target.value) });
    const versionInput = el('input', { type: 'text', value: d.version, placeholder: 'Ex.: 0.3.1 ou build 1482', oninput: (e) => (d.version = e.target.value) });
    const freqSel = el('select', { onchange: (e) => (d.frequency = e.target.value) }, FREQ.map(([v, l]) => el('option', { value: v, text: l, selected: v === d.frequency })));
    const platformInput = el('input', { type: 'text', list: 'platformList', value: d.platform, placeholder: 'Ex.: Windows, PS5, Android…', oninput: (e) => (d.platform = e.target.value) });

    const textarea = (key, placeholder, rows) => {
      const t = el('textarea', { placeholder, rows: String(rows || 3), oninput: (e) => (d[key] = e.target.value) });
      t.value = d[key];
      return t;
    };

    const labelsBox = el('div', { class: 'labels-editor' });
    const attachBox = el('div', { class: 'attach-editor' });

    const renderLabels = () => {
      labelsBox.textContent = '';
      for (const l of d.labels) {
        labelsBox.appendChild(chip(l, () => { d.labels = d.labels.filter((x) => x !== l); renderLabels(); }));
      }
      const input = el('input', {
        type: 'text',
        class: 'label-input',
        list: 'labelList',
        placeholder: d.labels.length ? '' : 'Escreve e prime Enter (ex.: crash, gráficos)…',
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            addFromInput();
          } else if (e.key === 'Backspace' && !input.value && d.labels.length) {
            d.labels = d.labels.slice(0, -1);
            renderLabels();
            labelsBox.querySelector('.label-input').focus();
          }
        },
        onchange: () => addFromInput(),
      });
      function addFromInput() {
        const v = input.value.replace(/,/g, '').trim();
        if (!v) return;
        d.labels = uniqLabels([...d.labels, v]);
        renderLabels();
        labelsBox.querySelector('.label-input').focus();
      }
      labelsBox.appendChild(input);
    };

    const renderAttachments = () => {
      attachBox.textContent = '';
      const grid = el('div', { class: 'att-grid' });
      for (const a of d.attachments) {
        const url = attachmentUrl(a.path);
        const thumb =
          a.kind === 'video'
            ? el('div', { class: 'thumb' }, el('video', { src: url + '#t=0.1', preload: 'metadata', muted: true, playsinline: true }), el('span', { class: 'play', text: '▶' }))
            : el('div', { class: 'thumb' }, el('img', { src: url, alt: a.name, loading: 'lazy' }));
        grid.appendChild(
          el(
            'div',
            { class: 'att', title: a.name, onclick: () => openViewer(a) },
            thumb,
            el('div', { class: 'att-name', text: a.name }),
            el('button', {
              class: 'att-x',
              title: 'Remover anexo',
              text: '×',
              onclick: (e) => { e.stopPropagation(); d.attachments = d.attachments.filter((x) => x.path !== a.path); renderAttachments(); },
            })
          )
        );
      }
      if (modal.uploading > 0) grid.appendChild(el('div', { class: 'att uploading', text: 'A anexar…' }));
      attachBox.appendChild(grid);
      attachBox.appendChild(
        el(
          'div',
          { class: 'attach-actions' },
          el('button', { class: 'btn-secondary', text: 'Anexar…', onclick: pickFiles }),
          el('span', { class: 'hint', text: 'Também podes colar (Ctrl+V) uma captura de ecrã ou arrastar ficheiros para aqui.' })
        )
      );
      attachBox.appendChild(el('div', { id: 'attach-note', class: 'hint warn', text: modal.note }));
    };

    // Estes dois são chamados também de fora (anexos assíncronos)
    modal.renderAttachments = renderAttachments;
    renderLabels();
    renderAttachments();

    return el(
      'div',
      { class: 'modal-body' },
      el(
        'div',
        { class: 'form-grid' },
        field('Título', titleInput, 'full'),
        field('Estado', statusSel),
        field('Prioridade', prioSel),
        field('Etiquetas', labelsBox, 'full'),
        field('Área', areaInput),
        field('Versão / build', versionInput),
        el('div', { class: 'section-title full', text: 'Reprodutibilidade' }),
        field('Frequência', freqSel),
        field('Plataforma', platformInput),
        field('Passos para reproduzir', textarea('steps', '1. …\n2. …', 4), 'full'),
        field('Comportamento esperado', textarea('expected', 'O que devia acontecer', 3)),
        field('Comportamento observado', textarea('actual', 'O que acontece na realidade', 3)),
        field('Notas / descrição', textarea('description', 'Contexto adicional, suspeitas, ligações…', 3), 'full'),
        el('div', { class: 'section-title full', text: 'Anexos (imagens e vídeos)' }),
        field('', attachBox, 'full')
      )
    );
  }

  function buildHistory(bug) {
    const entries = bug.history.slice().reverse();
    const list = el('div', { class: 'history' });
    if (!entries.length) list.appendChild(el('div', { class: 'empty small', text: 'Ainda não há alterações registadas.' }));
    for (const h of entries) {
      const label = FIELD_LABEL[h.field] || h.field;
      let text;
      if (h.field === 'created') text = h.note || 'Bug criado';
      else if (h.note) text = label + ': ' + h.note;
      else if (h.from !== undefined && h.to !== undefined) text = label + ': ' + h.from + ' → ' + h.to;
      else text = label + ': ' + (h.to !== undefined ? h.to : h.from);
      list.appendChild(el('div', { class: 'hist-row' }, el('span', { class: 'hist-date', text: fmtDateTime(h.at) }), el('span', { class: 'hist-text', text })));
    }
    return el('div', { class: 'modal-body' }, list);
  }

  // ---------- anexos ----------
  async function pickFiles() {
    const m = modal;
    if (!m) return;
    m.uploading += 1;
    if (m.renderAttachments) m.renderAttachments();
    const items = await request({ type: 'pickAttachments' });
    m.uploading -= 1;
    if (modal === m) {
      m.draft.attachments.push(...items);
      m.renderAttachments();
    }
  }

  function readBase64(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(file);
    });
  }

  async function handleFiles(files) {
    const m = modal;
    if (!m) return;
    m.note = '';
    for (const f of files) {
      const okType = /^(image|video)\//.test(f.type);
      if (!okType) {
        m.note = 'Só são aceites imagens e vídeos (' + f.name + ' foi ignorado).';
        continue;
      }
      if (f.size > MAX_FILE_BYTES) {
        m.note = f.name + ' é demasiado grande para arrastar/colar (máx. 50 MB). Usa o botão "Anexar…".';
        continue;
      }
      m.uploading += 1;
      m.renderAttachments();
      try {
        const data = await readBase64(f);
        let name = f.name || 'captura.png';
        if (/^image\.(png|jpe?g)$/i.test(name)) name = 'captura-' + new Date().toISOString().replace(/[:.]/g, '-') + name.slice(name.lastIndexOf('.'));
        const items = await request({ type: 'saveAttachmentData', name, data });
        if (modal === m) m.draft.attachments.push(...items);
      } catch {
        m.note = 'Não foi possível ler ' + f.name + '.';
      }
      m.uploading -= 1;
    }
    if (modal === m) {
      m.renderAttachments();
      updateAttachNote();
    }
  }

  function onPaste(e) {
    const files = e.clipboardData ? [...e.clipboardData.files] : [];
    if (files.length && modal && modal.tab === 'detalhes') {
      e.preventDefault();
      handleFiles(files);
    }
  }

  function openViewer(att) {
    closeViewer();
    const url = attachmentUrl(att.path);
    const note = el('div', { class: 'viewer-note' });
    const media =
      att.kind === 'video'
        ? el('video', { src: url, controls: true, class: 'viewer-media' })
        : el('img', { src: url, alt: att.name, class: 'viewer-media' });
    media.addEventListener('error', () => {
      note.textContent = 'Não foi possível mostrar este ficheiro aqui. Usa «Abrir no sistema».';
    });
    viewerEl = el(
      'div',
      { id: 'viewer-root', class: 'overlay viewer', onmousedown: (e) => { if (e.target === viewerEl) closeViewer(); } },
      el(
        'div',
        { class: 'viewer-box' },
        media,
        note,
        el(
          'div',
          { class: 'viewer-bar' },
          el('span', { class: 'viewer-name', text: att.name }),
          el('button', { class: 'btn-secondary', text: 'Abrir no sistema', onclick: () => vscode.postMessage({ type: 'openAttachment', path: att.path }) }),
          el('button', { class: 'btn-secondary', text: 'Mostrar na pasta', onclick: () => vscode.postMessage({ type: 'revealAttachment', path: att.path }) }),
          el('button', { class: 'btn-primary', text: 'Fechar', onclick: closeViewer })
        )
      )
    );
    document.body.appendChild(viewerEl);
  }

  function closeViewer() {
    if (viewerEl) {
      viewerEl.remove();
      viewerEl = null;
    }
  }

  // ---------- cliques fantasma ----------
  // O menu de um <select> é um popup nativo. Ao escolher uma opção, o clique pode
  // "atravessar" o popup e cair no elemento que está por baixo (linha, cartão,
  // cabeçalho). Um clique legítimo começa e acaba no mesmo elemento; se o botão
  // foi premido noutro sítio (o select), o clique é ignorado.
  let downTarget = null;
  document.addEventListener('mousedown', (e) => { downTarget = e.target; }, true);
  document.addEventListener('keydown', () => { downTarget = null; }, true);
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target;
      if (downTarget && !(downTarget.contains(t) || t.contains(downTarget))) {
        e.stopPropagation();
        e.preventDefault();
      }
      setTimeout(() => { downTarget = null; }, 0);
    },
    true
  );

  // ---------- teclado ----------
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (viewerEl) closeViewer();
      else if (modal) requestClose();
      else if (selected.size) { selected.clear(); renderBulk(); renderMain(); }
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && modal) {
      saveModal();
    }
  });

  function renderError(message) {
    app.textContent = '';
    app.appendChild(
      el(
        'div',
        { class: 'error-box' },
        el('p', { text: 'Não foi possível ler este ficheiro .bg.' }),
        el('p', { text: message }),
        el('button', { class: 'btn-primary', text: 'Abrir como texto', onclick: () => vscode.postMessage({ type: 'openText' }) })
      )
    );
  }

  // ---------- mensagens da extensão ----------
  window.addEventListener('message', (event) => {
    const msg = event.data;

    if (msg.type === 'attachmentsAdded') {
      const resolve = pendingReqs.get(msg.reqId);
      if (resolve) {
        pendingReqs.delete(msg.reqId);
        resolve(msg.items || []);
      }
      return;
    }

    if (msg.type !== 'load') return;

    if (msg.error) {
      loadError = msg.error;
      statsEl = mainEl = bulkEl = null;
      closeModal();
      closeViewer();
      renderError(msg.error);
      return;
    }

    const wasError = loadError !== null || !mainEl;
    loadError = null;
    baseUri = msg.baseUri || baseUri;
    state = {
      version: 1,
      nextId: msg.data.nextId,
      bugs: msg.data.bugs.map(normalizeBug),
    };

    if (wasError) buildShell();
    renderAll();

    if (modal && modal.id !== null && !findBug(modal.id)) closeModal();
  });

  vscode.postMessage({ type: 'ready' });
})();
