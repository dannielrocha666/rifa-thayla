/* Rifa da Thayla | SPA sem compilação: Supabase Auth + PostgreSQL/RLS. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const cfg = window.RIFA_CONFIG || {};
  const APP = {
    sb: null, profile: null, user: null, sellers: [], tickets: [],
    view: 'dashboard', page: 1, pageSize: 35, editing: null,
    channel: null, refreshPromise: null, toastTimer: 0,
  };
  const money = n => new Intl.NumberFormat('pt-BR', {style: 'currency', currency:'BRL'}).format(Number(n) || 0);
  const fmtNum = n => String(n).padStart(3, '0');
  const esc = str => String(str ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labelStatus = s => ({disponivel:'Disponível',reservado:'Reservado',pago:'Pago'}[s] || '—');
  const sellerOf = id => APP.sellers.find(s => s.id === id);
  const canEdit = t => APP.profile && (APP.profile.role === 'admin' || APP.profile.seller_id === t.seller_id);
  const visibleSellers = () => APP.profile?.role === 'admin' ? APP.sellers : APP.sellers.filter(x => x.id === APP.profile?.seller_id);
  const visibleTickets = () => APP.profile?.role === 'admin' ? APP.tickets : APP.tickets.filter(t => t.seller_id === APP.profile?.seller_id);

  function notify(message, bad = false) {
    const el = $('toast'); el.textContent = message; el.classList.toggle('bad', !!bad);
    el.classList.add('visible'); window.clearTimeout(APP.toastTimer);
    APP.toastTimer = window.setTimeout(() => el.classList.remove('visible'), 5000);
  }
  function errorText(err) {
    const msg = String(err?.message || err || 'Erro desconhecido');
    if (/failed to fetch|fetch failed|network/i.test(msg)) return 'Falha de conexão. Confira sua internet e tente novamente.';
    if (/Invalid login credentials|Email not confirmed/i.test(msg)) return 'E-mail ou senha inválidos, ou e-mail ainda não confirmado.';
    if (/JWT expired/i.test(msg)) return 'Sua sessão expirou. Entre novamente.';
    return msg;
  }
  function setBusy(id, busy, text) {
    const el = $(id); if (!el) return;
    if (busy) {el.dataset.original = el.textContent; el.disabled = true; el.textContent = text || 'Salvando…';}
    else {el.disabled = false; el.textContent = el.dataset.original || el.textContent;}
  }

  function showLogin() { $('loginView').classList.remove('hidden'); $('appView').classList.add('hidden'); }
  function showApp() { $('loginView').classList.add('hidden'); $('appView').classList.remove('hidden'); }
  async function boot() {
    wireEvents();
    if (!cfg.supabaseUrl?.startsWith('https://') || !cfg.supabaseAnonKey?.trim()) {
      $('configNotice').classList.remove('hidden');
      $('loginSubmit').disabled = true;
      return;
    }
    if (!window.supabase?.createClient) {
      $('loginError').textContent = 'Não foi possível carregar a biblioteca Supabase. Confira sua internet e recarregue.';
      $('loginSubmit').disabled = true;
      return;
    }
    try {
      APP.sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth:{autoRefreshToken:true,persistSession:true,detectSessionInUrl:false},
      });
      const {data:{session},error} = await APP.sb.auth.getSession();
      if (error) throw error;
      if (session?.user) await enter(session.user);
    } catch(err) { showLogin(); $('loginError').textContent = errorText(err); }
  }
  async function login(e) {
    e.preventDefault();
    if (!APP.sb) return;
    $('loginError').textContent = '';
    const email = $('loginEmail').value.trim();
    const password = $('loginPassword').value;
    setBusy('loginSubmit', true, 'Entrando…');
    try {
      const {data,error} = await APP.sb.auth.signInWithPassword({email,password});
      if (error) throw error;
      if (!data?.user) throw new Error('Não foi possível obter o usuário autenticado.');
      await enter(data.user);
      $('loginPassword').value = '';
    } catch(err) { $('loginError').textContent = errorText(err); }
    finally { setBusy('loginSubmit', false); }
  }
  async function enter(user) {
    APP.user = user;
    const {data:profile,error} = await APP.sb.from('profiles')
      .select('id,display_name,role,seller_id').eq('id', user.id).single();
    if (error || !profile) {
      await APP.sb.auth.signOut();
      APP.user = null;
      throw new Error('Seu e-mail está autenticado, mas ainda não foi autorizado como vendedor ou administrador. Cadastre o perfil no Supabase.');
    }
    if (!['admin','vendedor'].includes(profile.role) || (profile.role === 'vendedor' && !profile.seller_id)) {
      throw new Error('Perfil de acesso incompleto. Peça ao organizador para corrigir.');
    }
    APP.profile = profile;
    $('profileName').textContent = profile.display_name;
    $('profileRole').textContent = profile.role === 'admin' ? 'Administrador(a)' : 'Vendedor(a)';
    $('avatarLetter').textContent = profile.display_name.charAt(0).toUpperCase();
    $('csvButton').classList.toggle('hidden', profile.role !== 'admin');
    await loadData(); showApp();
    configureSellerSelectors();
    switchView('dashboard');
    subscribeToChanges();
  }
  async function signOut() {
    try {if (APP.channel) APP.sb.removeChannel(APP.channel); await APP.sb?.auth.signOut();}
    catch(err) {notify(errorText(err), true);}
    APP.profile = null; APP.user = null; APP.sellers = []; APP.tickets = []; APP.channel = null;
    showLogin();
  }
  async function loadData() {
    if (APP.refreshPromise) return APP.refreshPromise;
    APP.refreshPromise = (async () => {
      const {data:sellers,error:sErr} = await APP.sb.from('sellers')
        .select('id,name,start_number,end_number').order('id');
      if (sErr) throw sErr;
      if (!sellers?.length) throw new Error('Não existem vendedores cadastrados. Execute o script do banco.');
      const data = [];
      let start = 0;
      while (true) {
        const {data:batch,error} = await APP.sb.from('tickets')
          .select('number,seller_id,buyer_name,buyer_phone,status,notes,paid_at,version,updated_at')
          .order('number').range(start, start+299);
        if (error) throw error;
        data.push(...(batch || []));
        if (!batch || batch.length < 300) break;
        start += batch.length;
        if (start > 1200) break;
      }
      APP.sellers = sellers; APP.tickets = data;
      $('lastUpdated').textContent = new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
      render();
    })();
    try {await APP.refreshPromise;} finally {APP.refreshPromise = null;}
  }
  async function refresh() {
    if (!APP.profile) return;
    setBusy('refreshAll',true,'Atualizando…');
    try { await loadData(); notify('Informações atualizadas.'); }
    catch (err) {notify(errorText(err),true);}
    finally {setBusy('refreshAll',false);}
  }
  function subscribeToChanges() {
    if (APP.channel) APP.sb.removeChannel(APP.channel);
    APP.channel = APP.sb.channel('rifa-thayla-tickets')
      .on('postgres_changes', {event:'UPDATE',schema:'public',table:'tickets'}, () => {
        if (APP.profile) loadData().catch(err => console.warn('Sincronização:',err));
      }).subscribe();
  }
  function configureSellerSelectors() {
    for (const id of ['salesSeller','shareSeller']) {
      const el = $(id); const isSales = id === 'salesSeller';
      el.replaceChildren();
      if (isSales && APP.profile.role === 'admin') el.add(new Option('Todos os vendedores','all'));
      for (const seller of visibleSellers()) el.add(new Option(`${seller.name} (${fmtNum(seller.start_number)}–${fmtNum(seller.end_number)})`,String(seller.id)));
      if (APP.profile.role !== 'admin') el.value = String(APP.profile.seller_id);
    }
  }
  function switchView(view) {
    APP.view = view;
    const names = {dashboard:'Visão geral',sales:'Controle de números',share:'Imagem para clientes',prizes:'Premiação e sorteio'};
    for (const node of document.querySelectorAll('.page-view')) node.classList.toggle('hidden', node.id !== `view-${view}`);
    for (const node of document.querySelectorAll('[data-view]')) node.classList.toggle('active',node.dataset.view === view);
    $('currentSection').textContent = names[view];
    render(); window.scrollTo({top:0,behavior:'instant'});
  }
  function render() {if (!APP.profile) return; renderDashboard(); renderSales(); renderShare();}
  function renderDashboard() {
    const all = visibleTickets();
    const paid = all.filter(t=>t.status === 'pago').length;
    const reserved = all.filter(t=>t.status === 'reservado').length;
    const available = all.filter(t=>t.status === 'disponivel').length;
    const cards = [
      {icon:'🎟️',label:'Números atribuídos',value:all.length.toLocaleString('pt-BR'),foot:'Total da sua área'},
      {icon:'✅',label:'Pagos',value:paid.toLocaleString('pt-BR'),foot:`${Math.round((paid/Math.max(1,all.length))*100)}% dos números`},
      {icon:'⏳',label:'Reservados',value:reserved.toLocaleString('pt-BR'),foot:'Aguardando confirmação do Pix'},
      {icon:'💜',label:'Valor recebido',value:money(paid * (cfg.pricePerNumber || 10)),foot:`${available} números disponíveis`},
    ];
    $('kpiCards').innerHTML = cards.map(x=>`<article class="kpi-card"><div class="kpi-icon">${x.icon}</div><div class="kpi-label">${esc(x.label)}</div><div class="kpi-value">${esc(x.value)}</div><div class="kpi-foot">${esc(x.foot)}</div></article>`).join('');
    const tbody = $('sellerStats');
    tbody.innerHTML = visibleSellers().map(s=>{
      const rows=all.filter(t=>t.seller_id===s.id), p=rows.filter(t=>t.status==='pago').length;
      const r=rows.filter(t=>t.status==='reservado').length, d=rows.filter(t=>t.status==='disponivel').length;
      const pct=Math.round(p/Math.max(1,rows.length)*100);
      return `<tr><td><div class="seller-cell"><span class="seller-avatar">${esc(s.name.charAt(0))}</span>${esc(s.name)}</div></td>
        <td>${fmtNum(s.start_number)}–${fmtNum(s.end_number)}</td><td>${p}</td><td>${r}</td><td>${d}</td><td><div class="progress-track" title="${pct}% pagos"><div class="progress-fill" style="width:${pct}%"></div></div><small>${pct}%</small></td></tr>`;
    }).join('');
    document.querySelector('#view-dashboard .subtle-pill').textContent = `${visibleSellers().length} ${visibleSellers().length>1?'vendedores':'vendedor'}`;
  }
  function filteredTickets() {
    let rows = visibleTickets();
    const seller = $('salesSeller').value, status=$('salesStatus').value, q=$('searchTicket').value.trim().toLowerCase();
    if (seller !== 'all') rows = rows.filter(t=>t.seller_id === Number(seller));
    if (status !== 'all') rows = rows.filter(t=>t.status === status);
    if (q) rows = rows.filter(t => fmtNum(t.number).includes(q) || String(t.number).includes(q) || (t.buyer_name||'').toLowerCase().includes(q));
    return rows;
  }
  function renderSales() {
    const rows=filteredTickets(), maxPage=Math.max(1, Math.ceil(rows.length/APP.pageSize));
    APP.page=Math.min(APP.page,maxPage);
    const slice=rows.slice((APP.page-1)*APP.pageSize,APP.page*APP.pageSize);
    $('salesResultCount').textContent = `${rows.length} números encontrados`;
    $('ticketRows').innerHTML = slice.length ? slice.map(t=>{
      const d=t.paid_at ? new Date(t.paid_at).toLocaleDateString('pt-BR') : '—';
      const seller=sellerOf(t.seller_id)?.name || '—';
      return `<tr><td class="ticket-number">${fmtNum(t.number)}</td><td>${esc(seller)}</td><td>${esc(t.buyer_name || '—')}</td>
        <td><span class="status-pill status-${esc(t.status)}">${labelStatus(t.status)}</span></td><td>${esc(d)}</td><td><button class="edit-small" data-edit="${t.number}">Editar</button></td></tr>`;
    }).join('') : '<tr><td colspan="6">Nenhum número encontrado.</td></tr>';
    $('salesPager').innerHTML = `<button id="pagePrev" ${APP.page<=1?'disabled':''}>← Anterior</button> Página ${APP.page} de ${maxPage} <button id="pageNext" ${APP.page>=maxPage?'disabled':''}>Próxima →</button>`;
    $('pagePrev').addEventListener('click',()=>{APP.page--;renderSales();});
    $('pageNext').addEventListener('click',()=>{APP.page++;renderSales();});
  }
  function openEditor(num) {
    const t = APP.tickets.find(x=>x.number === num);
    if (!t || !canEdit(t)) {notify('Você não tem permissão para editar esse número.',true);return;}
    APP.editing={...t};
    $('modalTitle').textContent=`Número ${fmtNum(num)}`;
    $('modalSeller').textContent=sellerOf(t.seller_id)?.name || 'Vendedor';
    $('modalStatus').textContent=labelStatus(t.status);
    $('buyerName').value=t.buyer_name || '';
    $('buyerPhone').value=t.buyer_phone || '';
    $('ticketStatus').value=t.status;
    $('ticketNotes').value=t.notes || '';
    $('modalError').textContent='';
    $('releaseTicket').disabled=t.status==='disponivel';
    $('ticketDialog').showModal();
  }
  function closeEditor() {$('ticketDialog').close();APP.editing=null;}
  async function writeTicket(next) {
    const prev=APP.editing;
    if (!prev || !canEdit(prev)) throw new Error('Edição não permitida.');
    const {data,error}=await APP.sb.from('tickets').update(next)
      .eq('number',prev.number).eq('version',prev.version)
      .select('number,seller_id,buyer_name,buyer_phone,status,notes,paid_at,version,updated_at');
    if (error) throw error;
    if (!data?.length) throw new Error('Esse número foi alterado por outra pessoa. Atualize a tela antes de tentar novamente.');
    const pos=APP.tickets.findIndex(t=>t.number===prev.number);
    if(pos>=0)APP.tickets[pos]=data[0];
    closeEditor(); render(); notify(`Número ${fmtNum(prev.number)} salvo com sucesso.`);
    loadData().catch(err=>console.warn('Atualização:',err));
  }
  async function saveEditor(e) {
    e.preventDefault();
    if (!APP.editing) return;
    const status=$('ticketStatus').value;
    const name=$('buyerName').value.trim();
    $('modalError').textContent='';
    if (!['disponivel','reservado','pago'].includes(status)) { $('modalError').textContent='Situação inválida.';return;}
    if (status!=='disponivel' && name.length<2) { $('modalError').textContent='Informe o nome do comprador (mínimo 2 caracteres).';return;}
    const next = status==='disponivel' ? {buyer_name:null,buyer_phone:null,status,notes:null,paid_at:null} : {
      buyer_name:name, buyer_phone:$('buyerPhone').value.trim() || null,
      status, notes:$('ticketNotes').value.trim() || null,
      paid_at:status==='pago' ? (APP.editing.status==='pago'?APP.editing.paid_at:new Date().toISOString()) : null,
    };
    setBusy('saveTicket',true,'Salvando…');
    try {await writeTicket(next);} catch(err){$('modalError').textContent=errorText(err);}
    finally {setBusy('saveTicket',false);}
  }
  async function releaseEditor() {
    if (!APP.editing || APP.editing.status==='disponivel') return;
    if (!window.confirm(`Liberar o número ${fmtNum(APP.editing.number)}? Os dados do comprador serão apagados do registro.`)) return;
    setBusy('releaseTicket',true,'Liberando…');
    try {await writeTicket({buyer_name:null,buyer_phone:null,status:'disponivel',notes:null,paid_at:null});}
    catch(err){$('modalError').textContent=errorText(err);}
    finally {setBusy('releaseTicket',false);}
  }
  function getShareInfo() {
    const sellerId=Number($('shareSeller').value);
    const seller=visibleSellers().find(x=>x.id===sellerId) || visibleSellers()[0];
    if (!seller) return null;
    const rows=visibleTickets().filter(t=>t.seller_id===seller.id);
    return {seller, numbers:rows.filter(t=>t.status==='disponivel').map(t=>t.number), paid:rows.filter(t=>t.status==='pago').length, reserved:rows.filter(t=>t.status==='reservado').length};
  }
  function renderShare() {
    const data=getShareInfo();if(!data){$('shareCard').innerHTML='<div class="share-empty">Nenhum vendedor disponível.</div>';return;}
    const {seller,numbers,paid,reserved}=data;
    $('shareCard').innerHTML=`<div class="share-card-head"><span class="share-kicker">MISS BRASIL FASHION PARÁ</span><h3>Rifa da Thayla ✦</h3><p>Thayla Almeida • Representando o Maranhão</p></div>
      <div class="share-card-meta"><div class="share-meta-item"><span>VENDEDOR(A)</span><strong>${esc(seller.name)}</strong></div><div class="share-meta-item"><span>FAIXA</span><strong>${fmtNum(seller.start_number)}–${fmtNum(seller.end_number)}</strong></div><div class="share-meta-item"><span>LIVRES</span><strong>${numbers.length} números</strong></div></div>
      <div class="share-body"><div class="share-body-header"><h4>Números disponíveis</h4><small>${numbers.length} livres · ${paid+reserved} indisponíveis</small></div>
      ${numbers.length?`<div class="number-grid">${numbers.map(n=>`<span class="number-chip">${fmtNum(n)}</span>`).join('')}</div>`:'<div class="share-empty">Todos os números desta faixa foram reservados ou vendidos.</div>'}</div>
      <div class="share-card-foot"><span>🎟️ <b>${money(cfg.pricePerNumber || 10)}</b> por número</span><span>📅 Sorteio: <b>${esc(cfg.drawDate||'15/12/2026')} às ${esc(cfg.drawTime||'18h')}</b></span><span>💳 Pix: <b>${esc(cfg.pixKey||'62501022300')}</b></span></div><div class="share-card-bottom">Escolha seus números e fale com o vendedor para reservar!</div>`;
  }
  function copyAvailable() {
    const data=getShareInfo(); if (!data) return;
    const msg=`🎟️ RIFA DA THAYLA — ${data.seller.name}\nNúmeros disponíveis (${data.numbers.length}):\n${data.numbers.map(fmtNum).join(', ') || 'Nenhum disponível'}\n\n💰 R$ 10,00 por número\n🎉 Sorteio: 15/12/2026 às 18h\n💳 Pix: 62501022300\nConsulte o vendedor antes de pagar: a disponibilidade pode mudar.`;
    if(navigator.clipboard?.writeText) navigator.clipboard.writeText(msg).then(()=>notify('Lista copiada para o WhatsApp!')).catch(()=>fallbackCopy(msg));
    else fallbackCopy(msg);
  }
  function fallbackCopy(text) {
    const e=document.createElement('textarea');e.value=text;e.style.position='fixed';e.style.opacity='0';document.body.appendChild(e);e.select();
    try {document.execCommand('copy');notify('Lista copiada!');} catch{notify('Não foi possível copiar. Use o print ou PNG.',true);}
    e.remove();
  }
  // Renderer Canvas próprio: evita biblioteca pesada e permite PNG com 167 números bem legíveis.
  function makeImage() {
    const data=getShareInfo();if(!data)return;
    const {seller,numbers,paid,reserved}=data;
    const canvas=document.createElement('canvas'); const w=1200,p=65,cols=10,gap=11,chipW=(w-2*p-gap*(cols-1))/cols,chipH=57;
    const rows=Math.max(1,Math.ceil(numbers.length/cols)),headH=270,metaH=126,bodyY=headH+metaH;
    const bodyH=115+rows*(chipH+gap)+40,footerY=bodyY+bodyH,footerH=142;
    canvas.width=w;canvas.height=footerY+footerH;
    const ctx=canvas.getContext('2d'); if(!ctx) throw new Error('Não foi possível gerar a imagem neste navegador.');
    function rounded(x,y,ww,hh,r,fill,stroke){ctx.beginPath(); if(ctx.roundRect)ctx.roundRect(x,y,ww,hh,r);else {const rr=Math.min(r,ww/2,hh/2);ctx.moveTo(x+rr,y);ctx.lineTo(x+ww-rr,y);ctx.quadraticCurveTo(x+ww,y,x+ww,y+rr);ctx.lineTo(x+ww,y+hh-rr);ctx.quadraticCurveTo(x+ww,y+hh,x+ww-rr,y+hh);ctx.lineTo(x+rr,y+hh);ctx.quadraticCurveTo(x,y+hh,x,y+hh-rr);ctx.lineTo(x,y+rr);ctx.quadraticCurveTo(x,y,x+rr,y)} if(fill){ctx.fillStyle=fill;ctx.fill();}if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=2;ctx.stroke();}}
    function txt(text,x,y,font,color,align='left'){ctx.font=font;ctx.fillStyle=color;ctx.textAlign=align;ctx.fillText(text,x,y);}
    ctx.fillStyle='#fff';ctx.fillRect(0,0,w,canvas.height);
    const grad=ctx.createLinearGradient(0,0,w,headH);grad.addColorStop(0,'#44265e');grad.addColorStop(1,'#9665ad');ctx.fillStyle=grad;ctx.fillRect(0,0,w,headH);
    txt('✦  MISS BRASIL FASHION PARÁ  ✦',w/2,62,'bold 25px Arial','#f3dba2','center');
    txt('RIFA DA THAYLA',w/2,155,'bold 75px Arial','#ffffff','center');
    txt('Thayla Almeida • Representando o Maranhão',w/2,209,'27px Arial','#f4e8fa','center');
    ctx.fillStyle='#f8f3fb';ctx.fillRect(0,headH,w,metaH);
    for(const [idx,lab,value] of [[0,'VENDEDOR(A)',seller.name],[1,'FAIXA',`${fmtNum(seller.start_number)}–${fmtNum(seller.end_number)}`],[2,'DISPONÍVEIS',`${numbers.length} números`]]){
      const x=w*(idx+.5)/3;
      txt(lab,x,headH+42,'bold 20px Arial','#85748f','center');
      txt(value,x,headH+90,'bold 31px Arial','#5b3679','center');
    }
    txt('NÚMEROS DISPONÍVEIS',p,bodyY+60,'bold 32px Arial','#372a43');
    txt(`${paid+reserved} indisponíveis`,w-p,bodyY+60,'bold 23px Arial','#918396','right');
    if(!numbers.length) txt('Todos os números foram reservados ou vendidos.',w/2,bodyY+175,'26px Arial','#8c8195','center');
    numbers.forEach((n,i)=>{
      const x=p+(i%cols)*(chipW+gap),y=bodyY+93+Math.floor(i/cols)*(chipH+gap);
      rounded(x,y,chipW,chipH,12,'#f6f0fa','#e8ddef');
      txt(fmtNum(n),x+chipW/2,y+39,'bold 31px Arial','#563276','center');
    });
    ctx.fillStyle='#f9f5fb';ctx.fillRect(0,footerY,w,footerH-34);
    txt(`${money(cfg.pricePerNumber||10)} por número`,w/2,footerY+35,'bold 31px Arial','#5b3679','center');
    txt(`Sorteio: ${cfg.drawDate||'15/12/2026'} às ${cfg.drawTime||'18h'}     •     Pix: ${cfg.pixKey||'62501022300'}`,w/2,footerY+83,'24px Arial','#46354e','center');
    ctx.fillStyle='#4e2a6a';ctx.fillRect(0,footerY+footerH-34,w,34);
    txt('ESCOLHA SEUS NÚMEROS E CONSULTE O VENDEDOR!',w/2,footerY+footerH-10,'bold 19px Arial','#ffffff','center');
    const link=document.createElement('a');link.download=`rifa-thayla-disponiveis-${seller.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')}.png`;
    link.href=canvas.toDataURL('image/png');document.body.appendChild(link);link.click();link.remove();notify('Imagem PNG gerada. Envie pelo WhatsApp!');
  }
  function exportCsv() {
    if(APP.profile?.role!=='admin')return;
    const quote = val => {const raw=String(val??'');const safe=/^[=+@\-]/.test(raw)?`'${raw}`:raw;return `"${safe.replaceAll('"','""')}"`;};
    const header=['Número','Vendedor','Comprador','Telefone','Situação','Data pagamento','Observações'];
    const rows=APP.tickets.map(t=>[fmtNum(t.number),sellerOf(t.seller_id)?.name||'',t.buyer_name||'',t.buyer_phone||'',labelStatus(t.status),t.paid_at||'',t.notes||'']);
    const csv='\uFEFF'+[header,...rows].map(r=>r.map(quote).join(';')).join('\r\n');
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download='rifa-thayla-vendas.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function wireEvents() {
    $('loginForm').addEventListener('submit',login);
    $('togglePassword').addEventListener('click',()=>{
      const el=$('loginPassword'); el.type=el.type==='password'?'text':'password';
      $('togglePassword').textContent=el.type==='password'?'Mostrar':'Ocultar';
    });
    $('signOut').addEventListener('click',signOut);
    $('signOutMobile').addEventListener('click',signOut);
    $('refreshAll').addEventListener('click',refresh);
    document.querySelectorAll('[data-view]').forEach(btn=>btn.addEventListener('click',()=>switchView(btn.dataset.view)));
    $('searchTicket').addEventListener('input',()=>{APP.page=1;renderSales();});
    $('salesSeller').addEventListener('change',()=>{APP.page=1;renderSales();});
    $('salesStatus').addEventListener('change',()=>{APP.page=1;renderSales();});
    $('shareSeller').addEventListener('change',renderShare);
    $('ticketRows').addEventListener('click',e=>{const target=e.target.closest('[data-edit]');if(target)openEditor(Number(target.dataset.edit));});
    $('ticketEditor').addEventListener('submit',saveEditor);
    $('cancelTicket').addEventListener('click',closeEditor);
    $('closeModal').addEventListener('click',closeEditor);
    $('releaseTicket').addEventListener('click',releaseEditor);
    $('ticketDialog').addEventListener('close',()=>{APP.editing=null;});
    $('ticketStatus').addEventListener('change',()=>{$('releaseTicket').disabled=$('ticketStatus').value==='disponivel';});
    $('downloadImage').addEventListener('click',()=>{try{makeImage();}catch(err){notify(errorText(err),true);}});
    $('shareText').addEventListener('click',copyAvailable);
    $('printShare').addEventListener('click',()=>window.print());
    $('csvButton').addEventListener('click',exportCsv);
    setInterval(()=>{if(APP.profile && document.visibilityState === 'visible')loadData().catch(err=>console.warn('Consulta:',err));},45000);
  }
  // Iniciado depois do carregamento do SDK incluído com defer no index.html.
  if(document.readyState === 'loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
