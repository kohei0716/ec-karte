/* ECカルテ — 分析コア（DOM非依存。ブラウザ・Node双方で動く）
   方針（ナレッジDB KB-002 準拠）
   - 予測はしない。確定データの解釈と判断のみを出す
   - 単一指標でアラートを出さない。必ずカテゴリ集計と併記する
   - データ品質の前処理を製品仕様に含める
*/
(function(root){
'use strict';

/* ---------- 文字コード判定 ---------- */
function decodeBuf(buf){
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if(u8[0]===0xEF && u8[1]===0xBB && u8[2]===0xBF){
    return new TextDecoder('utf-8').decode(u8.subarray(3));
  }
  const utf = new TextDecoder('utf-8').decode(u8);
  const broken = (utf.match(/�/g)||[]).length;
  if(broken > 0){
    for(const enc of ['shift_jis','euc-jp']){
      try{
        const alt = new TextDecoder(enc).decode(u8);
        if((alt.match(/�/g)||[]).length < broken) return alt;
      }catch(e){}
    }
  }
  return utf;
}

/* ---------- CSVパーサ（クォート内のカンマ・改行に対応） ---------- */
function parseCSV(text){
  text = String(text).replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  const rows=[]; let row=[], cell='', q=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(q){
      if(c==='"'){ if(text[i+1]==='"'){cell+='"';i++;} else q=false; }
      else cell+=c;
    }else{
      if(c==='"') q=true;
      else if(c===','||c==='\t'){ row.push(cell); cell=''; }
      else if(c==='\n'){ row.push(cell); rows.push(row); row=[]; cell=''; }
      else cell+=c;
    }
  }
  if(cell!==''||row.length){ row.push(cell); rows.push(row); }
  return rows.filter(r=>r.some(v=>String(v).trim()!==''));
}

/* ---------- 列の自動判定 ---------- */
const FIELDS=[
  {k:'name',  label:'商品名',       req:true,  kw:['商品名','品名','商品名称','アイテム名','product_name','product name','item name','title','name','lineitem name']},
  {k:'amount',label:'金額（小計）', req:false, kw:['小計','金額','売上','商品計','明細金額','合計金額','subtotal','line total','amount','total']},
  {k:'price', label:'単価',         req:false, kw:['単価','価格','販売価格','商品単価','税抜単価','price','unit price','lineitem price']},
  {k:'qty',   label:'数量',         req:false, kw:['数量','個数','点数','購入数','quantity','qty','lineitem quantity']},
  {k:'code',  label:'商品コード',   req:false, kw:['商品コード','商品id','品番','sku','商品番号','janコード','item code','product code','variant sku']},
  {k:'date',  label:'受注日',       req:false, kw:['受注日','注文日','受注日時','注文日時','購入日','決済日','order date','created at','date','paid at']},
  {k:'cat',   label:'カテゴリ／ブランド', req:false, kw:['カテゴリ','分類','ブランド','商品分類','グループ','category','brand','product type','vendor','type']},
  {k:'cost',  label:'原価',         req:false, kw:['原価','仕入価格','仕入単価','仕入原価','cost','cost per item','unit cost']},
  {k:'stock', label:'在庫数',       req:false, kw:['在庫数','在庫','残在庫','在庫数量','stock','inventory','quantity available','在庫合計']},
  {k:'order', label:'注文番号',     req:false, kw:['注文番号','受注番号','受注id','伝票番号','order id','order number']}
];

function norm(s){ return String(s==null?'':s).toLowerCase().replace(/[\s_\-　（）()\[\]"']/g,''); }

function guess(headers){
  const used=new Set(), out={};
  for(const f of FIELDS){
    let best=-1, bestScore=0;
    headers.forEach((h,i)=>{
      if(used.has(i)) return;
      const n=norm(h);
      if(!n) return;
      for(const kw of f.kw){
        const k=norm(kw);
        let sc=0;
        if(n===k) sc=100;
        else if(n.indexOf(k)>=0) sc=60+k.length;
        else if(k.indexOf(n)>=0 && n.length>=2) sc=30+n.length;
        if(sc>bestScore){ bestScore=sc; best=i; }
      }
    });
    if(best>=0 && bestScore>=30){ out[f.k]=best; used.add(best); }
  }
  return out;
}

/* ---------- 数値パース（全角・通貨記号・カンマに対応） ---------- */
function num(v){
  if(v==null) return 0;
  let s=String(v).replace(/[０-９]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xFEE0))
                 .replace(/．/g,'.').replace(/[－ー―‐]/g,'-')
                 .replace(/[,¥￥円"'\s]/g,'');
  const m=s.match(/-?\d+(\.\d+)?/);
  if(!m) return 0;
  const n=parseFloat(m[0]);
  return isFinite(n)?n:0;
}

/* ---------- 期間の判定 ---------- */
function detectPeriod(rows, dateIdx, fallbackDays){
  let days=Math.max(1, parseInt(fallbackDays,10)||30);
  let note='指定値';
  if(dateIdx==null) return {days, note};
  const ts=[];
  for(const r of rows){
    const raw=r[dateIdx];
    if(raw==null) continue;
    const s=String(raw).trim().replace(/[年月]/g,'/').replace(/日/g,'').replace(/\./g,'/');
    if(!s) continue;
    const d=new Date(s);
    if(!isNaN(d.getTime()) && d.getFullYear()>2000 && d.getFullYear()<2100) ts.push(d.getTime());
  }
  if(ts.length>=2){
    const mn=Math.min.apply(null,ts), mx=Math.max.apply(null,ts);
    const span=(mx-mn)/86400000;
    if(span>=0.5){
      days=Math.max(1, Math.round(span)+1);
      note=new Date(mn).toLocaleDateString('ja-JP')+' 〜 '+new Date(mx).toLocaleDateString('ja-JP');
    }
  }
  return {days, note};
}

/* ---------- 集計本体 ---------- */
function compute(head, rows, M, fallbackDays){
  if(M.name==null) throw new Error('「商品名」の列を選んでください。集計の単位になります。');
  if(M.amount==null && M.price==null) throw new Error('「金額（小計）」か「単価」のどちらかを選んでください。');

  const g=(r,k)=> M[k]==null ? '' : (r[M[k]]==null ? '' : r[M[k]]);
  const per=detectPeriod(rows, M.date, fallbackDays);
  const days=per.days;

  const P=new Map(); const orders=new Set();
  let hasCost=false, hasStock=false;

  for(const r of rows){
    const name=String(g(r,'name')).trim();
    if(!name) continue;
    const code=String(g(r,'code')).trim();
    const key=code||name;
    const qty=M.qty!=null ? Math.max(0,num(g(r,'qty'))) : 1;
    const amt=M.amount!=null ? num(g(r,'amount')) : num(g(r,'price'))*qty;
    if(M.order!=null){ const o=String(g(r,'order')).trim(); if(o) orders.add(o); }

    if(!P.has(key)) P.set(key,{name,code,cat:'',qty:0,amt:0,cost:0,stock:null});
    const p=P.get(key);
    p.qty+=qty; p.amt+=amt;

    if(!p.cat){ const c=String(g(r,'cat')).trim(); if(c) p.cat=c; }
    if(M.cost!=null){ const c=num(g(r,'cost')); if(c>0){ p.cost+=c*qty; hasCost=true; } }
    if(M.stock!=null && String(g(r,'stock')).trim()!==''){
      const s=num(g(r,'stock'));
      p.stock = p.stock==null ? s : Math.max(p.stock, s);
      hasStock=true;
    }
  }

  const items=[...P.values()].filter(p=>p.qty>0||p.amt>0);
  if(!items.length) throw new Error('集計できる行がありませんでした。列の指定を見直してください。');

  items.forEach(p=>{
    if(!p.cat) p.cat='未分類';
    p.daily = p.qty/days;
    p.gross = hasCost ? p.amt-p.cost : null;
    p.gpr   = (hasCost && p.amt>0) ? (p.amt-p.cost)/p.amt : null;
    p.dio   = (hasStock && p.stock!=null)
                ? (p.daily>0 ? p.stock/p.daily : (p.stock>0 ? Infinity : 0))
                : null;
  });

  const totalAmt=items.reduce((a,p)=>a+p.amt,0);
  const totalQty=items.reduce((a,p)=>a+p.qty,0);
  const totalGross=hasCost?items.reduce((a,p)=>a+(p.gross||0),0):null;

  // カテゴリ集計（KB F-03: 追加生産は単品でなくカテゴリ全体で判断する）
  const C=new Map();
  items.forEach(p=>{
    if(!C.has(p.cat)) C.set(p.cat,{cat:p.cat,qty:0,amt:0,stock:0,n:0,hasStock:false});
    const c=C.get(p.cat);
    c.qty+=p.qty; c.amt+=p.amt; c.n++;
    if(p.stock!=null){ c.stock+=p.stock; c.hasStock=true; }
  });
  C.forEach(c=>{
    c.daily=c.qty/days;
    c.dio=(c.hasStock && c.daily>0) ? c.stock/c.daily : null;
  });

  const D={items,C,days,dateNote:per.note,totalAmt,totalQty,totalGross,
           orderCount:orders.size||null,hasCost,hasStock};
  D.actions=buildActions(D);
  return D;
}

/* ---------- 判断ロジック ---------- */
const TH={ THIN_DAYS:14, CAT_THIN_DAYS:45, SLOW_DAYS:120, LOW_GPR:0.30, MIN_SHARE:0.005 };

function buildActions(D){
  const {items,C,hasCost,hasStock,totalAmt}=D;
  const sold=items.filter(p=>p.qty>0);
  const catOf=n=>C.get(n);
  const A=[];

  if(hasStock){
    // 在庫0は「欠品」として別に扱う。ここは「まだ在庫はあるが、もうすぐ切れる」もの
    const thin=sold.filter(p=>p.dio!=null && p.dio<TH.THIN_DAYS && p.daily>0 && p.stock>0);

    A.push({id:'reorder',level:'danger',title:'欠品する前に追加発注する',
      why:'まだ在庫はありますが、在庫日数が14日を切っています。かつ同カテゴリ全体の在庫も45日未満で、カテゴリごと品薄です。作っても余りにくく、いま動けば欠品を防げます。',
      empty:'該当なし。2週間以内に切れそうな商品はありません。',
      items:thin.filter(p=>{const c=catOf(p.cat); return !c||c.dio==null||c.dio<TH.CAT_THIN_DAYS;})
               .sort((a,b)=>a.dio-b.dio).slice(0,8)});

    A.push({id:'hold',level:'warn',title:'品薄だが、発注は見送る',hideIfEmpty:true,
      why:'単品では在庫日数14日未満ですが、同カテゴリ全体の在庫が45日以上あります。カテゴリ内に余っている在庫があるため、単品の数字だけで追加すると全体の在庫が膨らみます。まずカテゴリ内の消化を優先してください。',
      items:thin.filter(p=>{const c=catOf(p.cat); return c&&c.dio!=null&&c.dio>=TH.CAT_THIN_DAYS;})
               .sort((a,b)=>a.dio-b.dio).slice(0,6)});

    A.push({id:'slow',level:'warn',title:'値引き・施策を検討する',
      why:'在庫日数が120日を超えています。今のペースでは4ヶ月以上売れ残ります。値引き、同梱、露出強化のいずれかを当ててください。',
      empty:'該当なし。滞留在庫はありません。',
      items:sold.filter(p=>p.dio!=null&&isFinite(p.dio)&&p.dio>TH.SLOW_DAYS)
                .sort((a,b)=>b.stock-a.stock).slice(0,8)});

    A.push({id:'dead',level:'warn',title:'期間中に1点も売れていない在庫',hideIfEmpty:true,
      why:'在庫はあるのに販売実績がゼロです。掲載切れ・写真なし・ページ統合による旧エントリの残骸の可能性があります。商品ページの表示を実際に確認してから判断してください。',
      items:items.filter(p=>p.stock!=null&&p.stock>0&&p.qty===0)
                 .sort((a,b)=>b.stock-a.stock).slice(0,8)});

    A.push({id:'oos',level:'danger',title:'今すぐ再入荷を手配する（欠品中）',
      why:'期間中に売れていたのに、在庫がゼロです。売れる状態のまま止まっているので、この損失は毎日増え続けます。日販から逆算した1ヶ月あたりの逸失売上を出しました。',
      empty:'該当なし。売れ筋の欠品はありません。',
      items:sold.filter(p=>p.stock===0&&p.daily>0)
                .sort((a,b)=>b.daily-a.daily).slice(0,8)});
  }

  if(hasCost){
    A.push({id:'lowgp',level:'warn',title:'売れているが粗利が薄い',
      why:'売上構成比0.5%以上で、粗利率30%未満の商品です。売上ランキング上位にいても利益は残っていません。値上げか原価の見直し対象です。',
      empty:'該当なし。薄利の主力商品はありません。',
      items:sold.filter(p=>p.gpr!=null&&p.gpr<TH.LOW_GPR&&p.amt>totalAmt*TH.MIN_SHARE)
                .sort((a,b)=>a.gpr-b.gpr).slice(0,6)});
  }

  return A.filter(a=>!(a.hideIfEmpty && !a.items.length));
}

function judge(p,C){
  if(p.dio==null) return null;
  if(p.stock===0 && p.daily>0) return {t:'欠品',c:'d'};
  if(!isFinite(p.dio)) return {t:'動きなし',c:'w'};
  if(p.dio<TH.THIN_DAYS){
    const c=C.get(p.cat);
    if(c&&c.dio!=null&&c.dio>=TH.CAT_THIN_DAYS) return {t:'品薄・様子見',c:'w'};
    return {t:'要追加',c:'d'};
  }
  if(p.dio>TH.SLOW_DAYS) return {t:'滞留',c:'w'};
  return {t:'適正',c:'o'};
}

/* ---------- 表示ヘルパ ---------- */
function yen(n){ return '¥'+Math.round(n).toLocaleString('ja-JP'); }
function pct(n){ return (n*100).toFixed(1)+'%'; }
function fmtDio(d){ return !isFinite(d) ? '販売なし' : (d>=999 ? '999日+' : Math.round(d)+'日'); }
function esc(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

root.ECK={decodeBuf,parseCSV,guess,num,compute,judge,detectPeriod,
          yen,pct,fmtDio,esc,FIELDS,TH};

})(typeof window!=='undefined' ? window : (typeof globalThis!=='undefined' ? globalThis : this));
