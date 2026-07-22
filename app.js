(() => {
  const STORAGE_KEY = "internal-stock-trading-mvp-v2";
  const LOT_SIZE = 100;
  const MATCH_DELAY_MS = 1000;
  const fillTimers = new Map();

  const ui = {
    authRole: "manager",
    activeView: "overview",
    selectedTraderId: null,
    selectedSymbol: "000001",
    orderSide: "buy",
    modal: null
  };

  let state = null;

  document.addEventListener("DOMContentLoaded", () => {
    state = loadState();
    ensureUiDefaults();
    bindEvents();
    resumePendingOrders();
    render();
    setInterval(refreshMarket, 5000);
  });

  function seedState() {
    const now = Date.now();
    const quotes = {
      "600519": stockQuote("600519", "贵州茅台", "主板", 1568.2, 1559.3, now),
      "000001": stockQuote("000001", "平安银行", "主板", 10.86, 10.79, now),
      "600036": stockQuote("600036", "招商银行", "主板", 38.42, 38.1, now),
      "000858": stockQuote("000858", "五粮液", "主板", 129.7, 128.6, now),
      "300750": stockQuote("300750", "宁德时代", "创业板", 281.35, 279.2, now),
      "688981": stockQuote("688981", "中芯国际", "科创板", 89.42, 88.8, now),
      "002594": stockQuote("002594", "比亚迪", "主板", 308.4, 305.9, now),
      "600000": stockQuote("600000", "浦发银行", "主板", 8.43, 8.39, now)
    };

    return {
      currentUserId: null,
      settings: {
        accountLabel: "个人证券账户",
        apiStatus: "实盘API已开通",
        globalOpen: true,
        t0Mode: true,
        allowBoards: ["主板", "创业板", "科创板", "ST"],
        risk: {
          singleOrderMax: 300000,
          singleStockMax: 900000,
          dailyLossLimit: 50000,
          maxDailyTrades: 80,
          priceDeviationPct: 2,
          quoteStaleSec: 8
        },
        fees: {
          commissionRate: 0.0003,
          transferRate: 0.00001,
          stampTaxRate: 0.001
        },
        interfaces: {
          brokerName: "示例券商",
          accountNo: "沪A 888888",
          environment: "仿真",
          tradeEndpoint: "https://broker-api.example/trade",
          marketEndpoint: "https://broker-api.example/market",
          tradeStatus: "已连接",
          marketStatus: "已连接",
          lastCheckedAt: now - 1000 * 60 * 3,
          lastSyncAt: now - 1000 * 60 * 2
        }
      },
      users: [
        newManager("boss-001", "boss", "李总", "123456", "boss"),
        newManager("admin-001", "admin", "王管理员", "123456", "admin"),
        newTrader("trader-zhang", "zhangsan", "张三", "123456", 1000000),
        newTrader("trader-li", "lisi", "李四", "123456", 800000),
        newTrader("trader-wang", "wangwu", "王五", "123456", 600000)
      ],
      mainAccount: {
        cash: 5000000,
        holdings: [
          mainHolding(quotes["000001"], 30000, 30000, 10.2),
          mainHolding(quotes["600036"], 12000, 12000, 36.8),
          mainHolding(quotes["600000"], 50000, 50000, 8.1)
        ]
      },
      allocationRecords: [],
      orders: [],
      audit: [
        {
          id: makeId("audit"),
          time: now,
          type: "系统",
          operator: "系统",
          message: "演示环境初始化：个人证券主账户、主账户底仓池、内部虚拟子账户。"
        }
      ],
      market: { quotes }
    };
  }

  function newManager(id, username, name, password, role = "admin") {
    return {
      id,
      role,
      username,
      password,
      name,
      status: "active"
    };
  }

  function newTrader(id, username, name, password, capital) {
    return {
      id,
      role: "trader",
      username,
      password,
      name,
      status: "active",
      capital,
      cash: capital,
      realizedPnL: 0,
      fees: 0,
      positions: []
    };
  }

  function stockQuote(symbol, name, board, last, prevClose, now) {
    const spread = Math.max(0.01, round2(last * 0.0004));
    return {
      symbol,
      name,
      board,
      last,
      prevClose,
      bid1: round2(last - spread / 2),
      ask1: round2(last + spread / 2),
      updatedAt: now
    };
  }

  function mainHolding(quote, qty, availableQty, avgCost) {
    return {
      symbol: quote.symbol,
      name: quote.name,
      board: quote.board,
      qty,
      availableQty,
      avgCost
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return seedState();
      return normalizeState(JSON.parse(raw));
    } catch (error) {
      console.warn("Failed to load state", error);
      return seedState();
    }
  }

  function normalizeState(next) {
    const seeded = seedState();
    next.settings = {
      ...seeded.settings,
      ...(next.settings || {}),
      risk: { ...seeded.settings.risk, ...((next.settings && next.settings.risk) || {}) },
      fees: { ...seeded.settings.fees, ...((next.settings && next.settings.fees) || {}) },
      interfaces: { ...seeded.settings.interfaces, ...((next.settings && next.settings.interfaces) || {}) }
    };
    next.users = Array.isArray(next.users) ? next.users : seeded.users;
    if (!next.users.some((user) => user.role === "boss")) next.users.unshift(seeded.users[0]);
    if (!next.users.some((user) => user.role === "admin")) next.users.splice(1, 0, seeded.users[1]);
    next.mainAccount = next.mainAccount || seeded.mainAccount;
    next.mainAccount.cash = Number(next.mainAccount.cash || 0);
    next.mainAccount.holdings = Array.isArray(next.mainAccount.holdings) ? next.mainAccount.holdings : seeded.mainAccount.holdings;
    next.allocationRecords = Array.isArray(next.allocationRecords) ? next.allocationRecords : [];
    next.orders = Array.isArray(next.orders) ? next.orders : [];
    next.audit = Array.isArray(next.audit) ? next.audit : [];
    next.market = next.market || seeded.market;
    next.market.quotes = { ...seeded.market.quotes, ...((next.market && next.market.quotes) || {}) };

    next.users.forEach((user) => {
      user.status = user.status || "active";
      if (user.role === "trader") {
        user.capital = Number(user.capital || 0);
        user.cash = Number(user.cash || 0);
        user.realizedPnL = Number(user.realizedPnL || 0);
        user.fees = Number(user.fees || 0);
        user.positions = Array.isArray(user.positions) ? user.positions : [];
      }
    });
    next.mainAccount.holdings.forEach((holding) => {
      const quote = getQuoteFromState(next, holding.symbol);
      holding.name = holding.name || quote.name;
      holding.board = holding.board || quote.board;
      holding.qty = Number(holding.qty || 0);
      holding.availableQty = Number(holding.availableQty || 0);
      holding.avgCost = Number(holding.avgCost || quote.last);
    });
    return next;
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      console.warn("Failed to persist state", error);
    }
  }

  function bindEvents() {
    document.addEventListener("click", handleClick);
    document.addEventListener("submit", handleSubmit);
    document.addEventListener("change", handleChange);
  }

  function handleClick(event) {
    const trigger = event.target.closest("[data-action]");
    if (!trigger) return;
    const action = trigger.dataset.action;

    if (action === "set-auth-role") {
      ui.authRole = trigger.dataset.role;
      render();
      return;
    }

    if (action === "quick-login") {
      login(trigger.dataset.role, trigger.dataset.username, trigger.dataset.password);
      return;
    }

    if (action === "logout") {
      logout();
      return;
    }

    if (action === "reset-demo") {
      if (confirm("重置后会清空当前演示数据，是否继续？")) resetDemo();
      return;
    }

    if (action === "nav") {
      ui.activeView = trigger.dataset.view;
      ensureUiDefaults();
      render();
      return;
    }

    if (action === "select-symbol") {
      ui.selectedSymbol = trigger.dataset.symbol;
      render();
      return;
    }

    if (action === "select-trader") {
      ui.selectedTraderId = trigger.dataset.traderId;
      render();
      return;
    }

    if (action === "toggle-global-open") {
      state.settings.globalOpen = !state.settings.globalOpen;
      addAudit("风控", state.settings.globalOpen ? "恢复全员开仓权限。" : "执行一键禁止开仓。");
      persist();
      render();
      showToast(state.settings.globalOpen ? "已恢复开仓" : "已禁止开仓", "shield-check");
      return;
    }

    if (action === "toggle-user") {
      toggleUserStatus(trigger.dataset.userId);
      return;
    }

    if (action === "open-modal") {
      ui.modal = {
        type: trigger.dataset.modal,
        traderId: trigger.dataset.traderId || ui.selectedTraderId
      };
      render();
      return;
    }

    if (action === "close-modal") {
      ui.modal = null;
      render();
      return;
    }

    if (action === "cancel-order") {
      cancelOrder(trigger.dataset.orderId);
      return;
    }

    if (action === "boss-close-all") {
      closeAllPositions(trigger.dataset.traderId, "管理端一键平仓");
      return;
    }

    if (action === "prefill-sell") {
      ui.selectedSymbol = trigger.dataset.symbol;
      ui.orderSide = "sell";
      ui.activeView = "trade";
      render();
      return;
    }

    if (action === "test-interface") {
      testInterface(trigger.dataset.target);
      return;
    }

    if (action === "sync-main-account") {
      syncMainAccount();
    }
  }

  function handleSubmit(event) {
    const form = event.target.closest("form[data-form]");
    if (!form) return;
    event.preventDefault();
    const formType = form.dataset.form;
    const data = new FormData(form);

    if (formType === "login") {
      login(ui.authRole, data.get("username"), data.get("password"));
      return;
    }

    if (formType === "create-user") {
      createUser(data);
      return;
    }

    if (formType === "allocation") {
      saveAllocation(data);
      return;
    }

    if (formType === "assign-position") {
      assignPosition(data);
      return;
    }

    if (formType === "main-holding") {
      saveMainHolding(data);
      return;
    }

    if (formType === "settings") {
      saveSettings(data);
      return;
    }

    if (formType === "interface-settings") {
      saveInterfaceSettings(data);
      return;
    }

    if (formType === "trade-order" || formType === "manager-order") {
      const current = getCurrentUser();
      const source = isManagementUser(current) ? "管理端代下单" : "交易员下单";
      placeOrder({
        userId: data.get("targetUserId"),
        symbol: data.get("symbol"),
        side: data.get("side"),
        price: Number(data.get("price")),
        qty: Number(data.get("qty")),
        source
      });
      if (formType === "manager-order") ui.modal = null;
    }
  }

  function handleChange(event) {
    const target = event.target;
    if (target.matches("[data-control='symbol-select']")) {
      ui.selectedSymbol = target.value;
      render();
      return;
    }
    if (target.matches("[data-control='order-side']")) {
      ui.orderSide = target.value;
      render();
      return;
    }
    if (target.matches("[data-control='trader-select']")) {
      ui.selectedTraderId = target.value;
      render();
    }
  }

  function login(role, username, password) {
    const cleanUsername = String(username || "").trim();
    const cleanPassword = String(password || "");
    const user = state.users.find((item) => {
      const roleOk = role === "manager" ? isManagementRole(item.role) : item.role === "trader";
      return roleOk && item.username === cleanUsername && item.password === cleanPassword;
    });
    if (!user) {
      showToast("账号或密码不正确", "circle-alert");
      return;
    }
    if (user.status !== "active") {
      showToast("账号已禁用，请联系管理端", "circle-alert");
      return;
    }
    state.currentUserId = user.id;
    ui.activeView = isManagementUser(user) ? "overview" : "trade";
    ui.selectedTraderId = isManagementUser(user) ? getTraders()[0]?.id || null : user.id;
    addAudit("登录", `${user.name} 登录系统。`);
    persist();
    render();
    showToast(`已登录：${user.name}`, "log-in");
  }

  function logout() {
    const user = getCurrentUser();
    if (user) addAudit("登录", `${user.name} 退出系统。`);
    state.currentUserId = null;
    persist();
    render();
  }

  function resetDemo() {
    for (const timer of fillTimers.values()) clearTimeout(timer);
    fillTimers.clear();
    state = seedState();
    ui.activeView = "overview";
    ui.selectedTraderId = "trader-zhang";
    ui.selectedSymbol = "000001";
    ui.orderSide = "buy";
    ui.modal = null;
    persist();
    render();
    showToast("演示数据已重置", "rotate-ccw");
  }

  function toggleUserStatus(userId) {
    const user = getUser(userId);
    if (!user || user.role === "boss") {
      showToast("老板账号不可禁用", "circle-alert");
      return;
    }
    user.status = user.status === "active" ? "disabled" : "active";
    addAudit("权限", `${user.name} 已${user.status === "active" ? "启用" : "禁用"}。`);
    persist();
    render();
    showToast(user.status === "active" ? "账号已启用" : "账号已禁用", "shield");
  }

  function createUser(data) {
    const role = data.get("role") === "admin" ? "admin" : "trader";
    const username = String(data.get("username") || "").trim();
    const password = String(data.get("password") || "");
    const name = String(data.get("name") || "").trim();
    const capital = Number(data.get("capital") || 0);

    if (!username || !password || !name) {
      showToast("请填写姓名、用户名和密码", "circle-alert");
      return;
    }
    if (state.users.some((user) => user.username === username)) {
      showToast("用户名已存在", "circle-alert");
      return;
    }

    const user = role === "admin" ? newManager(makeId("admin"), username, name, password, "admin") : newTrader(makeId("trader"), username, name, password, Math.max(0, capital));
    state.users.push(user);
    if (role === "trader") ui.selectedTraderId = user.id;
    ui.modal = null;
    addAudit("权限", `新建${roleLabel(role)} ${name}，用户名 ${username}。`);
    persist();
    render();
    showToast(`${roleLabel(role)}已创建`, "user-plus");
  }

  function saveAllocation(data) {
    const trader = getUser(data.get("traderId"));
    if (!trader || trader.role !== "trader") {
      showToast("请选择交易员", "circle-alert");
      return;
    }
    const beforeCapital = trader.capital;
    const nextCapital = Number(data.get("capital") || 0);
    const nextStatus = data.get("status") === "disabled" ? "disabled" : "active";
    const diff = round2(nextCapital - trader.capital);
    if (trader.cash + diff < 0) {
      showToast("减少额度不能超过现金可用", "circle-alert");
      return;
    }
    trader.capital = nextCapital;
    trader.cash = round2(trader.cash + diff);
    trader.status = nextStatus;
    ui.selectedTraderId = trader.id;
    state.allocationRecords.unshift({
      id: makeId("alloc"),
      time: Date.now(),
      type: "资金额度",
      traderId: trader.id,
      traderName: trader.name,
      symbol: "-",
      name: "-",
      qty: 0,
      amount: diff,
      operator: getCurrentUser()?.name || "管理端",
      note: `额度 ${formatMoneyPlain(beforeCapital)} -> ${formatMoneyPlain(nextCapital)}，状态 ${statusText(nextStatus)}`
    });
    addAudit("分配", `调整 ${trader.name} 资金为 ${formatMoneyPlain(nextCapital)}，状态为 ${statusText(nextStatus)}。`);
    persist();
    render();
    showToast("资金和权限已更新", "wallet-cards");
  }

  function assignPosition(data) {
    const trader = getUser(data.get("traderId"));
    const quote = getQuote(data.get("symbol"));
    const holding = findMainHolding(data.get("symbol"));
    const qty = Number(data.get("qty") || 0);
    const cost = Number(data.get("cost") || 0);
    if (!trader || trader.role !== "trader" || !quote || !holding) {
      showToast("请选择交易员和主账户底仓", "circle-alert");
      return;
    }
    if (!validLot(qty) || cost <= 0) {
      showToast(`数量必须为 ${LOT_SIZE} 的整数倍，成本价必须大于0`, "circle-alert");
      return;
    }
    if (holding.availableQty < qty) {
      showToast("主账户未分配底仓不足", "circle-alert");
      return;
    }
    const value = round2(qty * cost);
    if (trader.cash < value) {
      showToast("交易员虚拟现金不足，请先增加额度", "circle-alert");
      return;
    }
    holding.availableQty = Math.max(0, holding.availableQty - qty);
    trader.cash = round2(trader.cash - value);
    upsertPosition(trader, quote, qty, cost, qty);
    ui.selectedTraderId = trader.id;
    state.allocationRecords.unshift({
      id: makeId("alloc"),
      time: Date.now(),
      type: "底仓分配",
      traderId: trader.id,
      traderName: trader.name,
      symbol: quote.symbol,
      name: quote.name,
      qty,
      amount: value,
      operator: getCurrentUser()?.name || "管理端",
      note: `主账户未分配底仓减少 ${formatQty(qty)} 股`
    });
    addAudit("底仓", `给 ${trader.name} 分配 ${quote.symbol} ${quote.name} ${qty} 股，成本 ${cost.toFixed(2)}。`);
    persist();
    render();
    showToast("底仓已从主账户分配", "badge-check");
  }

  function saveMainHolding(data) {
    const quote = getQuote(data.get("symbol"));
    const qty = Number(data.get("qty") || 0);
    const availableQty = Number(data.get("availableQty") || 0);
    const avgCost = Number(data.get("avgCost") || 0);
    if (!quote || !validLot(qty) || availableQty < 0 || availableQty > qty || avgCost <= 0) {
      showToast("请检查主账户持仓数量、可分配数量和成本价", "circle-alert");
      return;
    }
    const holding = findMainHolding(quote.symbol);
    if (holding) {
      holding.qty = qty;
      holding.availableQty = availableQty;
      holding.avgCost = avgCost;
      holding.name = quote.name;
      holding.board = quote.board;
    } else {
      state.mainAccount.holdings.push(mainHolding(quote, qty, availableQty, avgCost));
    }
    addAudit("主账户", `更新主账户底仓 ${quote.symbol} ${quote.name}，总持仓 ${qty}，未分配 ${availableQty}。`);
    persist();
    render();
    showToast("主账户底仓已更新", "database");
  }

  function saveSettings(data) {
    state.settings.globalOpen = data.get("globalOpen") === "true";
    state.settings.t0Mode = data.get("t0Mode") === "true";
    state.settings.allowBoards = data.getAll("allowBoards");
    state.settings.risk.singleOrderMax = Number(data.get("singleOrderMax") || 0);
    state.settings.risk.singleStockMax = Number(data.get("singleStockMax") || 0);
    state.settings.risk.dailyLossLimit = Number(data.get("dailyLossLimit") || 0);
    state.settings.risk.maxDailyTrades = Number(data.get("maxDailyTrades") || 0);
    state.settings.risk.priceDeviationPct = Number(data.get("priceDeviationPct") || 0);
    state.settings.risk.quoteStaleSec = Number(data.get("quoteStaleSec") || 0);
    state.settings.fees.commissionRate = Number(data.get("commissionRate") || 0) / 100;
    state.settings.fees.transferRate = Number(data.get("transferRate") || 0) / 100;
    state.settings.fees.stampTaxRate = Number(data.get("stampTaxRate") || 0) / 100;
    addAudit("风控", "保存自定义风控和费用规则。");
    persist();
    render();
    showToast("风控规则已保存", "shield-check");
  }

  function saveInterfaceSettings(data) {
    state.settings.interfaces.brokerName = String(data.get("brokerName") || "").trim() || "未配置";
    state.settings.interfaces.accountNo = String(data.get("accountNo") || "").trim() || "未配置";
    state.settings.interfaces.environment = String(data.get("environment") || "仿真");
    state.settings.interfaces.tradeEndpoint = String(data.get("tradeEndpoint") || "").trim();
    state.settings.interfaces.marketEndpoint = String(data.get("marketEndpoint") || "").trim();
    state.settings.accountLabel = `${state.settings.interfaces.brokerName} · ${state.settings.interfaces.accountNo}`;
    addAudit("接口", "保存券商接口与主账户配置。");
    persist();
    render();
    showToast("接口配置已保存", "plug-zap");
  }

  function testInterface(target) {
    const now = Date.now();
    if (target === "market") state.settings.interfaces.marketStatus = "已连接";
    else state.settings.interfaces.tradeStatus = "已连接";
    state.settings.interfaces.lastCheckedAt = now;
    state.settings.apiStatus = "实盘API已开通";
    addAudit("接口", `${target === "market" ? "行情接口" : "交易接口"}连接测试通过。`);
    persist();
    render();
    showToast("接口测试通过", "badge-check");
  }

  function syncMainAccount() {
    state.settings.interfaces.lastSyncAt = Date.now();
    addAudit("接口", "同步主账户资金、持仓和可用底仓数据。");
    persist();
    render();
    showToast("主账户数据已同步", "refresh-cw");
  }

  function placeOrder({ userId, symbol, side, price, qty, source, immediate = false, force = false }) {
    const current = getCurrentUser();
    const trader = getUser(userId);
    const quote = getQuote(symbol);
    if (!current || !trader || trader.role !== "trader" || !quote) {
      showToast("下单账户或股票无效", "circle-alert");
      return false;
    }
    if (current.role === "trader" && current.id !== trader.id) {
      showToast("交易员只能操作自己的账户", "circle-alert");
      return false;
    }
    if (trader.status !== "active") {
      showToast("交易员已禁用，不能下单", "circle-alert");
      return false;
    }
    if (!validLot(qty) || price <= 0) {
      showToast(`数量必须为 ${LOT_SIZE} 的整数倍，价格必须大于0`, "circle-alert");
      return false;
    }

    side = side === "sell" ? "sell" : "buy";
    const gross = round2(price * qty);
    const fee = calcFees(side, gross);
    const now = Date.now();
    const order = {
      id: makeId("order"),
      userId: trader.id,
      traderName: trader.name,
      source,
      symbol: quote.symbol,
      name: quote.name,
      board: quote.board,
      side,
      price,
      qty,
      amount: gross,
      fee,
      status: "已报",
      filledQty: 0,
      createdAt: now,
      fillAt: immediate ? now : now + MATCH_DELAY_MS,
      reservedCash: 0,
      reservedQty: 0
    };

    const validation = validateOrder(trader, quote, order, force);
    if (!validation.ok) {
      showToast(validation.message, "circle-alert");
      return false;
    }

    if (side === "buy") {
      order.reservedCash = round2(gross + fee);
      trader.cash = round2(trader.cash - order.reservedCash);
    } else {
      const position = findPosition(trader, symbol);
      order.reservedQty = qty;
      position.availableQty = Math.max(0, position.availableQty - qty);
    }

    state.orders.unshift(order);
    addAudit("委托", `${source}：${trader.name} ${sideText(side)} ${quote.symbol} ${quote.name} ${qty} 股，价格 ${price.toFixed(2)}。`);
    persist();

    if (immediate) fillOrder(order.id);
    else {
      scheduleFill(order.id);
      render();
      showToast("委托已报入", "send");
    }
    return true;
  }

  function validateOrder(trader, quote, order, force) {
    const side = order.side;
    const risk = state.settings.risk;
    const now = Date.now();
    if (!force) {
      if (side === "buy" && !state.settings.globalOpen) return { ok: false, message: "当前已禁止开仓，只允许卖出平仓" };
      if (!state.settings.allowBoards.includes(quote.board)) return { ok: false, message: `${quote.board} 当前不在允许交易范围内` };
      if (now - quote.updatedAt > risk.quoteStaleSec * 1000) return { ok: false, message: "行情已过期，禁止下单" };
      if (side === "buy" && order.amount > risk.singleOrderMax) return { ok: false, message: "超过单笔最大买入金额" };
      if (side === "buy" && getPositionValue(trader, quote.symbol) + order.amount > risk.singleStockMax) return { ok: false, message: "超过单只股票最大持仓金额" };
      if (side === "buy" && getTraderTotalPnl(trader) <= -Math.abs(risk.dailyLossLimit)) return { ok: false, message: "已触发亏损限制，只允许卖出" };
      if (risk.maxDailyTrades > 0 && getTodayOrders(trader.id).length >= risk.maxDailyTrades) return { ok: false, message: "已达到单日最大交易次数" };
      if (side === "buy" && order.price > quote.ask1 * (1 + risk.priceDeviationPct / 100)) return { ok: false, message: "买入价偏离卖一价过高" };
      if (side === "sell" && order.price < quote.bid1 * (1 - risk.priceDeviationPct / 100)) return { ok: false, message: "卖出价偏离买一价过低" };
    }

    if (side === "buy") {
      const required = round2(order.amount + order.fee);
      if (trader.cash < required) return { ok: false, message: "虚拟可用资金不足" };
      if (state.mainAccount.cash < required) return { ok: false, message: "主账户现金不足，不能实盘买入" };
    } else {
      const position = findPosition(trader, quote.symbol);
      if (!position || position.availableQty < order.qty) return { ok: false, message: "可卖股数不足" };
    }
    return { ok: true };
  }

  function scheduleFill(orderId) {
    if (fillTimers.has(orderId)) clearTimeout(fillTimers.get(orderId));
    const order = getOrder(orderId);
    if (!order || order.status !== "已报") return;
    const delay = Math.max(0, order.fillAt - Date.now());
    const timer = setTimeout(() => {
      fillTimers.delete(orderId);
      fillOrder(orderId);
    }, delay);
    fillTimers.set(orderId, timer);
  }

  function resumePendingOrders() {
    state.orders.filter((order) => order.status === "已报").forEach((order) => scheduleFill(order.id));
  }

  function fillOrder(orderId) {
    const order = getOrder(orderId);
    if (!order || order.status !== "已报") return;
    const trader = getUser(order.userId);
    const quote = getQuote(order.symbol);
    if (!trader || !quote) return;

    if (order.side === "buy") {
      const costPerShare = (order.amount + order.fee) / order.qty;
      upsertPosition(trader, quote, order.qty, costPerShare, state.settings.t0Mode ? order.qty : 0);
      trader.fees = round2(trader.fees + order.fee);
      state.mainAccount.cash = round2(state.mainAccount.cash - order.amount - order.fee);
      upsertMainHolding(quote, order.qty, 0, order.price);
    } else {
      const position = findPosition(trader, order.symbol);
      if (!position || position.qty < order.qty) {
        order.status = "废单";
        addAudit("委托", `${trader.name} ${order.symbol} 卖出委托废单：持仓不足。`);
        persist();
        render();
        return;
      }
      const realized = round2((order.price - position.avgCost) * order.qty - order.fee);
      trader.cash = round2(trader.cash + order.amount - order.fee);
      trader.realizedPnL = round2(trader.realizedPnL + realized);
      trader.fees = round2(trader.fees + order.fee);
      position.qty = round2(position.qty - order.qty);
      position.availableQty = Math.min(position.availableQty, position.qty);
      if (position.qty <= 0) trader.positions = trader.positions.filter((item) => item.symbol !== order.symbol);
      state.mainAccount.cash = round2(state.mainAccount.cash + order.amount - order.fee);
      reduceMainHolding(order.symbol, order.qty);
    }

    order.status = "全部成交";
    order.filledQty = order.qty;
    order.filledAt = Date.now();
    addAudit("成交", `${trader.name} ${sideText(order.side)} ${order.symbol} ${order.qty} 股已成交，成交价 ${order.price.toFixed(2)}。`);
    persist();
    render();
    showToast("委托已成交", "badge-check");
  }

  function cancelOrder(orderId) {
    const order = getOrder(orderId);
    if (!order || order.status !== "已报") {
      showToast("当前委托不可撤", "circle-alert");
      return;
    }
    const trader = getUser(order.userId);
    if (!trader) return;
    if (fillTimers.has(orderId)) {
      clearTimeout(fillTimers.get(orderId));
      fillTimers.delete(orderId);
    }
    if (order.side === "buy") trader.cash = round2(trader.cash + order.reservedCash);
    else {
      const position = findPosition(trader, order.symbol);
      if (position) position.availableQty = Math.min(position.qty, position.availableQty + order.reservedQty);
    }
    order.status = "已撤";
    order.canceledAt = Date.now();
    addAudit("撤单", `${trader.name} 撤销 ${order.symbol} ${sideText(order.side)} 委托。`);
    persist();
    render();
    showToast("委托已撤销", "circle-x");
  }

  function closeAllPositions(traderId, source) {
    const trader = getUser(traderId);
    if (!trader || trader.role !== "trader") return;
    const sellable = trader.positions.filter((position) => position.availableQty > 0);
    if (!sellable.length) {
      showToast("该交易员暂无可平持仓", "circle-alert");
      return;
    }
    sellable.forEach((position) => {
      const quote = getQuote(position.symbol);
      if (quote) {
        placeOrder({
          userId: trader.id,
          symbol: position.symbol,
          side: "sell",
          price: quote.bid1,
          qty: position.availableQty,
          source,
          immediate: true,
          force: true
        });
      }
    });
    addAudit("风控", `${source}：${trader.name} 全部可卖持仓。`);
    persist();
    render();
  }

  function upsertPosition(trader, quote, qty, cost, availableAdded) {
    let position = findPosition(trader, quote.symbol);
    if (!position) {
      position = { symbol: quote.symbol, name: quote.name, board: quote.board, qty: 0, availableQty: 0, avgCost: 0 };
      trader.positions.push(position);
    }
    const currentCost = position.avgCost * position.qty;
    const addedCost = cost * qty;
    const nextQty = position.qty + qty;
    position.qty = nextQty;
    position.availableQty = Math.min(nextQty, position.availableQty + availableAdded);
    position.avgCost = nextQty > 0 ? round4((currentCost + addedCost) / nextQty) : 0;
  }

  function upsertMainHolding(quote, qty, availableAdded, cost) {
    let holding = findMainHolding(quote.symbol);
    if (!holding) {
      holding = mainHolding(quote, 0, 0, cost);
      state.mainAccount.holdings.push(holding);
    }
    const currentCost = holding.avgCost * holding.qty;
    const addedCost = cost * qty;
    const nextQty = holding.qty + qty;
    holding.qty = nextQty;
    holding.availableQty = Math.min(nextQty, holding.availableQty + availableAdded);
    holding.avgCost = nextQty > 0 ? round4((currentCost + addedCost) / nextQty) : 0;
  }

  function reduceMainHolding(symbol, qty) {
    const holding = findMainHolding(symbol);
    if (!holding) return;
    holding.qty = Math.max(0, holding.qty - qty);
    holding.availableQty = Math.min(holding.availableQty, holding.qty);
    if (holding.qty <= 0) state.mainAccount.holdings = state.mainAccount.holdings.filter((item) => item.symbol !== symbol);
  }

  function refreshMarket() {
    if (!state) return;
    const now = Date.now();
    Object.values(state.market.quotes).forEach((quote) => {
      const drift = quote.last * ((Math.random() - 0.46) * 0.0022);
      const next = Math.max(0.01, round2(quote.last + drift));
      const spread = Math.max(0.01, round2(next * 0.00045));
      quote.last = next;
      quote.bid1 = round2(next - spread / 2);
      quote.ask1 = round2(next + spread / 2);
      quote.updatedAt = now;
    });
    persist();
    if (getCurrentUser()) render();
  }

  function render() {
    ensureUiDefaults();
    const root = document.getElementById("root");
    const user = getCurrentUser();
    root.innerHTML = user ? renderApp(user) : renderAuth();
    document.getElementById("modal-root").innerHTML = renderModal();
    if (window.lucide) window.lucide.createIcons();
  }

  function renderAuth() {
    const role = ui.authRole;
    return `
      <main class="auth-shell">
        <section class="auth-side">
          <div class="brand-lockup">
            <div class="brand-mark"><i data-lucide="candlestick-chart"></i></div>
            <div class="brand-text">
              <h1>内部交易终端</h1>
              <p>个人证券账户 · 主账户底仓 · 虚拟分仓</p>
            </div>
          </div>

          <div class="auth-snapshot">
            <div class="snapshot-row"><span>开户方式</span><strong>管理端创建账号</strong></div>
            <div class="snapshot-row"><span>资产来源</span><strong>统一个人证券主账户</strong></div>
            <div class="snapshot-row"><span>底仓流程</span><strong>主账户库存 -> 交易员分配</strong></div>
            <div class="snapshot-row"><span>审计范围</span><strong>账号 / 分配 / 委托 / 接口</strong></div>
          </div>

          <div class="demo-strip">
            <div class="demo-pill">
              <span>老板演示</span>
              <button class="btn btn-small" type="button" data-action="quick-login" data-role="manager" data-username="boss" data-password="123456">
                <i data-lucide="log-in"></i>boss / 123456
              </button>
            </div>
            <div class="demo-pill">
              <span>管理员演示</span>
              <button class="btn btn-small" type="button" data-action="quick-login" data-role="manager" data-username="admin" data-password="123456">
                <i data-lucide="log-in"></i>admin / 123456
              </button>
            </div>
            <div class="demo-pill">
              <span>交易员演示</span>
              <button class="btn btn-small" type="button" data-action="quick-login" data-role="trader" data-username="zhangsan" data-password="123456">
                <i data-lucide="log-in"></i>zhangsan / 123456
              </button>
            </div>
            <button class="btn btn-ghost" type="button" data-action="reset-demo">
              <i data-lucide="rotate-ccw"></i>重置演示数据
            </button>
          </div>
        </section>

        <section class="auth-main">
          <div class="auth-panel">
            <h2>登录系统</h2>
            <p class="subtext">账号由管理端创建，登录页不开放注册。</p>

            <div class="segmented">
              <button type="button" data-action="set-auth-role" data-role="manager" class="${role === "manager" ? "active" : ""}">管理端</button>
              <button type="button" data-action="set-auth-role" data-role="trader" class="${role === "trader" ? "active" : ""}">交易员</button>
            </div>

            <form class="form-grid" data-form="login">
              <div class="form-row">
                <label for="login-username">用户名</label>
                <input id="login-username" name="username" autocomplete="username" placeholder="${role === "manager" ? "boss 或 admin" : "zhangsan"}" required />
              </div>
              <div class="form-row">
                <label for="login-password">密码</label>
                <input id="login-password" name="password" type="password" autocomplete="current-password" placeholder="123456" required />
              </div>
              <div class="auth-actions">
                <button class="btn btn-primary" type="submit"><i data-lucide="log-in"></i>登录系统</button>
              </div>
            </form>
          </div>
        </section>
      </main>
    `;
  }

  function renderApp(user) {
    const nav = getNav(user.role);
    if (!nav.some((item) => item.id === ui.activeView)) ui.activeView = nav[0].id;
    const active = nav.find((item) => item.id === ui.activeView);
    return `
      <div class="app-shell">
        <aside class="sidebar">
          <div class="brand-lockup">
            <div class="brand-mark"><i data-lucide="candlestick-chart"></i></div>
            <div class="brand-text">
              <h1>交易终端</h1>
              <p>${roleLabel(user.role)}工作台</p>
            </div>
          </div>
          <nav class="nav-list" aria-label="主导航">
            ${nav.map((item) => `<button class="nav-item ${ui.activeView === item.id ? "active" : ""}" type="button" data-action="nav" data-view="${item.id}"><i data-lucide="${item.icon}"></i>${item.label}</button>`).join("")}
          </nav>
          <div class="sidebar-footer">
            <div class="user-chip">
              <strong>${h(user.name)}</strong>
              <span>${h(user.username)} · ${roleLabel(user.role)}</span>
            </div>
            <button class="btn btn-ghost" type="button" data-action="logout"><i data-lucide="log-out"></i>退出登录</button>
          </div>
        </aside>

        <section class="main">
          <header class="topbar">
            <div>
              <h2>${active.label}</h2>
              <div class="topbar-meta">
                <span class="badge good"><span class="status-dot"></span>${h(state.settings.apiStatus)}</span>
                <span class="badge info">${h(state.settings.accountLabel)}</span>
                <span class="badge ${state.settings.globalOpen ? "good" : "danger"}">${state.settings.globalOpen ? "允许开仓" : "禁止开仓"}</span>
                <span class="badge purple">日内做T：${state.settings.t0Mode ? "启用" : "关闭"}</span>
              </div>
            </div>
            <div class="toolbar">
              ${
                isManagementUser(user)
                  ? `
                    <button class="btn ${state.settings.globalOpen ? "btn-danger" : "btn-success"}" type="button" data-action="toggle-global-open">
                      <i data-lucide="${state.settings.globalOpen ? "ban" : "circle-play"}"></i>${state.settings.globalOpen ? "一键禁止开仓" : "恢复开仓"}
                    </button>
                    <button class="btn" type="button" data-action="open-modal" data-modal="createUser"><i data-lucide="user-plus"></i>新建账号</button>
                  `
                  : ""
              }
              <button class="btn" type="button" data-action="reset-demo"><i data-lucide="rotate-ccw"></i>重置</button>
              <button class="btn btn-ghost" type="button" data-action="logout"><i data-lucide="log-out"></i>退出</button>
            </div>
          </header>
          ${isManagementUser(user) ? renderManagerView() : renderTraderView(user)}
        </section>
      </div>
    `;
  }

  function getNav(role) {
    if (isManagementRole(role)) {
      return [
        { id: "overview", label: "总览", icon: "layout-dashboard" },
        { id: "main-account", label: "主账户", icon: "database" },
        { id: "accounts", label: "账号管理", icon: "users-round" },
        { id: "allocation", label: "分仓分配", icon: "wallet-cards" },
        { id: "risk", label: "风控设置", icon: "shield-check" },
        { id: "interfaces", label: "接口管理", icon: "plug-zap" },
        { id: "logs", label: "订单日志", icon: "clipboard-list" }
      ];
    }
    return [
      { id: "trade", label: "交易台", icon: "monitor-up" },
      { id: "positions", label: "持仓盈亏", icon: "chart-candlestick" },
      { id: "my-orders", label: "委托成交", icon: "clipboard-list" },
      { id: "pnl", label: "盈亏", icon: "chart-line" },
      { id: "rules", label: "风控规则", icon: "shield" }
    ];
  }

  function renderManagerView() {
    if (ui.activeView === "main-account") return renderMainAccount();
    if (ui.activeView === "accounts") return renderAccounts();
    if (ui.activeView === "allocation") return renderAllocation();
    if (ui.activeView === "risk") return renderRiskSettings();
    if (ui.activeView === "interfaces") return renderInterfaceManagement();
    if (ui.activeView === "logs") return renderLogs();
    return renderOverview();
  }

  function renderOverview() {
    const traders = getTraders();
    const metrics = getGlobalMetrics();
    const main = getMainAccountMetrics();
    return `
      <main class="content">
        ${renderTicker()}
        <div class="metric-grid">
          ${metric("主账户总资产", formatMoneyPlain(main.equity), "现金 + 主账户股票市值", "wallet")}
          ${metric("未分配底仓", formatMoneyPlain(main.unallocatedValue), `${formatQty(main.unallocatedQty)} 股可分配`, "database")}
          ${metric("虚拟子账户资产", formatMoneyPlain(metrics.equity), `${traders.length} 个交易员`, "users-round")}
          ${metric("子账户总盈亏", signedMoney(metrics.pnl), "浮动 + 已实现，含费用", "chart-line", pnlClass(metrics.pnl))}
        </div>

        <section class="panel">
          <div class="panel-head">
            <h3>管理动作</h3>
            <div class="toolbar">
              <button class="btn btn-primary" type="button" data-action="open-modal" data-modal="createUser"><i data-lucide="user-plus"></i>新建账号</button>
              <button class="btn" type="button" data-action="nav" data-view="main-account"><i data-lucide="database"></i>主账户底仓</button>
              <button class="btn" type="button" data-action="nav" data-view="allocation"><i data-lucide="wallet-cards"></i>资金/底仓分配</button>
              <button class="btn" type="button" data-action="nav" data-view="interfaces"><i data-lucide="plug-zap"></i>接口管理</button>
            </div>
          </div>
          <div class="panel-body">
            <div class="three-col">
              ${miniRule("账号入口", "登录页不开放注册", "管理员在管理端创建管理员和交易员")}
              ${miniRule("底仓来源", "主账户库存", "分配前先有主账户底仓和可分配数量")}
              ${miniRule("审计闭环", "全流程留痕", "账号、分配、委托、成交、接口操作都进入日志")}
            </div>
          </div>
        </section>

        <div class="split-grid">
          <section class="panel">
            <div class="panel-head">
              <h3>主账户底仓</h3>
              <button class="btn btn-small" type="button" data-action="nav" data-view="main-account"><i data-lucide="arrow-right"></i>查看</button>
            </div>
            ${renderMainHoldingsTable(state.mainAccount.holdings.slice(0, 5))}
          </section>

          <section class="panel">
            <div class="panel-head"><h3>风险提醒</h3></div>
            <div class="panel-body">${renderRiskAlerts()}</div>
          </section>
        </div>

        <section class="panel">
          <div class="panel-head">
            <h3>最近分配记录</h3>
            <button class="btn btn-small" type="button" data-action="nav" data-view="allocation"><i data-lucide="list"></i>全部记录</button>
          </div>
          ${renderAllocationTable(state.allocationRecords.slice(0, 6))}
        </section>
      </main>
    `;
  }

  function renderMainAccount() {
    const main = getMainAccountMetrics();
    const quote = getQuote(ui.selectedSymbol);
    const currentHolding = findMainHolding(ui.selectedSymbol);
    return `
      <main class="content">
        <div class="metric-grid">
          ${metric("主账户总资产", formatMoneyPlain(main.equity), "现金 + 股票市值", "wallet")}
          ${metric("主账户现金", formatMoneyPlain(state.mainAccount.cash), "实盘买入会占用", "banknote")}
          ${metric("主账户股票市值", formatMoneyPlain(main.holdingsValue), `${state.mainAccount.holdings.length} 只股票`, "briefcase-business")}
          ${metric("未分配底仓市值", formatMoneyPlain(main.unallocatedValue), "可继续分给交易员", "database")}
        </div>

        <div class="split-grid">
          <section class="panel">
            <div class="panel-head">
              <h3>主账户底仓库存</h3>
              <button class="btn btn-small" type="button" data-action="sync-main-account"><i data-lucide="refresh-cw"></i>同步资金持仓</button>
            </div>
            ${renderMainHoldingsTable(state.mainAccount.holdings)}
          </section>

          <section class="panel">
            <div class="panel-head"><h3>手工维护底仓</h3></div>
            <div class="panel-body">
              <form class="inline-form" data-form="main-holding">
                <div class="form-row">
                  <label for="main-symbol">股票</label>
                  <select id="main-symbol" name="symbol" data-control="symbol-select">${renderSymbolOptions(ui.selectedSymbol)}</select>
                </div>
                <div class="form-row two">
                  <div>
                    <label for="main-qty">总持仓</label>
                    <input id="main-qty" name="qty" type="number" min="100" step="100" value="${currentHolding?.qty || 10000}" />
                  </div>
                  <div>
                    <label for="main-available">未分配可用</label>
                    <input id="main-available" name="availableQty" type="number" min="0" step="100" value="${currentHolding?.availableQty || 10000}" />
                  </div>
                </div>
                <div class="form-row">
                  <label for="main-cost">成本价</label>
                  <input id="main-cost" name="avgCost" type="number" min="0.01" step="0.01" value="${(currentHolding?.avgCost || quote.last).toFixed(2)}" />
                </div>
                <p class="hint">实盘后这里应由券商资金持仓接口同步，原型里保留手工维护入口便于演示闭环。</p>
                <button class="btn btn-primary" type="submit"><i data-lucide="save"></i>保存主账户底仓</button>
              </form>
            </div>
          </section>
        </div>
      </main>
    `;
  }

  function renderAccounts() {
    const managers = getManagers();
    const traders = getTraders();
    const selected = getUser(ui.selectedTraderId) || traders[0];
    return `
      <main class="content">
        <section class="panel">
          <div class="panel-head">
            <h3>管理员账号</h3>
            <button class="btn btn-small" type="button" data-action="open-modal" data-modal="createUser"><i data-lucide="user-plus"></i>新建账号</button>
          </div>
          ${renderManagerTable(managers)}
        </section>

        <div class="split-grid">
          <section class="panel">
            <div class="panel-head">
              <h3>交易员账号</h3>
              <button class="btn btn-small" type="button" data-action="open-modal" data-modal="createUser"><i data-lucide="user-plus"></i>新增</button>
            </div>
            ${renderTraderTable(traders, true)}
          </section>

          <section class="panel">
            <div class="panel-head">
              <h3>${selected ? h(selected.name) : "交易员详情"}</h3>
              ${
                selected
                  ? `
                    <div class="toolbar">
                      <button class="btn btn-small" type="button" data-action="open-modal" data-modal="managerTrade" data-trader-id="${selected.id}"><i data-lucide="send"></i>代下单</button>
                      <button class="btn btn-small btn-danger" type="button" data-action="boss-close-all" data-trader-id="${selected.id}"><i data-lucide="circle-stop"></i>一键平仓</button>
                    </div>
                  `
                  : ""
              }
            </div>
            <div class="panel-body">${selected ? renderTraderDetail(selected) : `<div class="empty-state">暂无交易员</div>`}</div>
          </section>
        </div>
      </main>
    `;
  }

  function renderAllocation() {
    const traders = getTraders();
    const selected = getUser(ui.selectedTraderId) || traders[0];
    const holding = findMainHolding(ui.selectedSymbol);
    return `
      <main class="content">
        <div class="two-col">
          <section class="panel">
            <div class="panel-head"><h3>资金与权限分配</h3></div>
            <div class="panel-body">
              <form class="inline-form" data-form="allocation">
                <div class="form-row">
                  <label for="allocation-trader">交易员</label>
                  <select id="allocation-trader" name="traderId" data-control="trader-select">
                    ${traders.map((trader) => option(trader.id, `${trader.name} / ${trader.username}`, selected?.id === trader.id)).join("")}
                  </select>
                </div>
                <div class="form-row two">
                  <div>
                    <label for="allocation-capital">虚拟资金</label>
                    <input id="allocation-capital" name="capital" type="number" min="0" step="10000" value="${selected ? selected.capital : 0}" />
                  </div>
                  <div>
                    <label for="allocation-status">交易权限</label>
                    <select id="allocation-status" name="status">
                      ${option("active", "启用", selected?.status === "active")}
                      ${option("disabled", "禁用", selected?.status === "disabled")}
                    </select>
                  </div>
                </div>
                <button class="btn btn-primary" type="submit"><i data-lucide="save"></i>保存分配</button>
              </form>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h3>底仓分配</h3></div>
            <div class="panel-body">
              <form class="inline-form" data-form="assign-position">
                <div class="form-row">
                  <label for="position-trader">交易员</label>
                  <select id="position-trader" name="traderId" data-control="trader-select">
                    ${traders.map((trader) => option(trader.id, `${trader.name} / ${trader.username}`, selected?.id === trader.id)).join("")}
                  </select>
                </div>
                <div class="form-row two">
                  <div>
                    <label for="position-symbol">主账户底仓</label>
                    <select id="position-symbol" name="symbol" data-control="symbol-select">${renderMainHoldingOptions(ui.selectedSymbol)}</select>
                  </div>
                  <div>
                    <label for="position-qty">分配数量</label>
                    <input id="position-qty" name="qty" type="number" min="100" step="100" value="${Math.min(1000, holding?.availableQty || 1000)}" />
                  </div>
                </div>
                <div class="form-row">
                  <label for="position-cost">分配成本价</label>
                  <input id="position-cost" name="cost" type="number" min="0.01" step="0.01" value="${(holding?.avgCost || getQuote(ui.selectedSymbol).last).toFixed(2)}" />
                </div>
                <div class="compact-list">
                  ${compactRow("主账户总持仓", formatQty(holding?.qty || 0))}
                  ${compactRow("未分配可用", formatQty(holding?.availableQty || 0))}
                </div>
                <p class="hint">分配后会生成分配记录，主账户未分配可用减少，交易员持仓和虚拟现金同步变化。</p>
                <button class="btn btn-primary" type="submit"><i data-lucide="badge-check"></i>分配底仓</button>
              </form>
            </div>
          </section>
        </div>

        <section class="panel">
          <div class="panel-head"><h3>主账户未分配底仓</h3></div>
          ${renderMainHoldingsTable(state.mainAccount.holdings)}
        </section>

        <section class="panel">
          <div class="panel-head"><h3>分配记录</h3></div>
          ${renderAllocationTable(state.allocationRecords)}
        </section>
      </main>
    `;
  }

  function renderRiskSettings() {
    const risk = state.settings.risk;
    const fees = state.settings.fees;
    const boards = ["主板", "创业板", "科创板", "ST"];
    return `
      <main class="content">
        <section class="panel">
          <div class="panel-head"><h3>自定义风控规则</h3></div>
          <div class="panel-body">
            <form class="inline-form" data-form="settings">
              <div class="form-row two">
                <div>
                  <label for="global-open">开仓状态</label>
                  <select id="global-open" name="globalOpen">
                    ${option("true", "允许开仓", state.settings.globalOpen)}
                    ${option("false", "禁止开仓，只允许卖出", !state.settings.globalOpen)}
                  </select>
                </div>
                <div>
                  <label for="t0-mode">日内做T入口</label>
                  <select id="t0-mode" name="t0Mode">
                    ${option("true", "启用", state.settings.t0Mode)}
                    ${option("false", "关闭", !state.settings.t0Mode)}
                  </select>
                </div>
              </div>

              <div class="form-row two">
                <div>
                  <label for="single-order-max">单笔最大买入金额</label>
                  <input id="single-order-max" name="singleOrderMax" type="number" min="0" step="10000" value="${risk.singleOrderMax}" />
                </div>
                <div>
                  <label for="single-stock-max">单只股票最大持仓金额</label>
                  <input id="single-stock-max" name="singleStockMax" type="number" min="0" step="10000" value="${risk.singleStockMax}" />
                </div>
              </div>

              <div class="form-row two">
                <div>
                  <label for="daily-loss-limit">单日亏损限制</label>
                  <input id="daily-loss-limit" name="dailyLossLimit" type="number" min="0" step="1000" value="${risk.dailyLossLimit}" />
                </div>
                <div>
                  <label for="max-daily-trades">单日最大交易次数</label>
                  <input id="max-daily-trades" name="maxDailyTrades" type="number" min="0" step="1" value="${risk.maxDailyTrades}" />
                </div>
              </div>

              <div class="form-row two">
                <div>
                  <label for="price-deviation">价格偏离阈值（%）</label>
                  <input id="price-deviation" name="priceDeviationPct" type="number" min="0" step="0.1" value="${risk.priceDeviationPct}" />
                </div>
                <div>
                  <label for="quote-stale">行情过期秒数</label>
                  <input id="quote-stale" name="quoteStaleSec" type="number" min="1" step="1" value="${risk.quoteStaleSec}" />
                </div>
              </div>

              <div class="form-row">
                <label>允许交易板块</label>
                <div class="check-grid">
                  ${boards.map((board) => `<label class="check-tile"><input type="checkbox" name="allowBoards" value="${board}" ${state.settings.allowBoards.includes(board) ? "checked" : ""} />${board}</label>`).join("")}
                </div>
              </div>

              <div class="form-row two">
                <div>
                  <label for="commission-rate">佣金率（%）</label>
                  <input id="commission-rate" name="commissionRate" type="number" min="0" step="0.001" value="${(fees.commissionRate * 100).toFixed(3)}" />
                </div>
                <div>
                  <label for="transfer-rate">过户费率（%）</label>
                  <input id="transfer-rate" name="transferRate" type="number" min="0" step="0.001" value="${(fees.transferRate * 100).toFixed(3)}" />
                </div>
              </div>

              <div class="form-row">
                <label for="stamp-tax-rate">卖出印花税率（%）</label>
                <input id="stamp-tax-rate" name="stampTaxRate" type="number" min="0" step="0.001" value="${(fees.stampTaxRate * 100).toFixed(3)}" />
              </div>

              <button class="btn btn-primary" type="submit"><i data-lucide="save"></i>保存规则</button>
            </form>
          </div>
        </section>
      </main>
    `;
  }

  function renderInterfaceManagement() {
    const api = state.settings.interfaces;
    return `
      <main class="content">
        <div class="metric-grid">
          ${metric("交易接口", api.tradeStatus, `最近检测 ${formatTime(api.lastCheckedAt)}`, "plug-zap", api.tradeStatus === "已连接" ? "positive" : "negative")}
          ${metric("行情接口", api.marketStatus, `最近检测 ${formatTime(api.lastCheckedAt)}`, "radio-tower", api.marketStatus === "已连接" ? "positive" : "negative")}
          ${metric("主账户同步", formatTime(api.lastSyncAt), "资金持仓同步时间", "refresh-cw")}
          ${metric("接入环境", h(api.environment), "演示可切换仿真/实盘", "server-cog")}
        </div>

        <div class="split-grid">
          <section class="panel">
            <div class="panel-head">
              <h3>券商接口配置</h3>
              <div class="toolbar">
                <button class="btn btn-small" type="button" data-action="test-interface" data-target="trade"><i data-lucide="plug-zap"></i>测试交易</button>
                <button class="btn btn-small" type="button" data-action="test-interface" data-target="market"><i data-lucide="radio-tower"></i>测试行情</button>
                <button class="btn btn-small" type="button" data-action="sync-main-account"><i data-lucide="refresh-cw"></i>同步主账户</button>
              </div>
            </div>
            <div class="panel-body">
              <form class="inline-form" data-form="interface-settings">
                <div class="form-row two">
                  <div>
                    <label for="broker-name">券商名称</label>
                    <input id="broker-name" name="brokerName" value="${h(api.brokerName)}" />
                  </div>
                  <div>
                    <label for="account-no">主账户号</label>
                    <input id="account-no" name="accountNo" value="${h(api.accountNo)}" />
                  </div>
                </div>
                <div class="form-row">
                  <label for="api-env">接口环境</label>
                  <select id="api-env" name="environment">
                    ${option("仿真", "仿真", api.environment === "仿真")}
                    ${option("实盘", "实盘", api.environment === "实盘")}
                  </select>
                </div>
                <div class="form-row">
                  <label for="trade-endpoint">交易接口地址</label>
                  <input id="trade-endpoint" name="tradeEndpoint" value="${h(api.tradeEndpoint)}" />
                </div>
                <div class="form-row">
                  <label for="market-endpoint">行情接口地址</label>
                  <input id="market-endpoint" name="marketEndpoint" value="${h(api.marketEndpoint)}" />
                </div>
                <button class="btn btn-primary" type="submit"><i data-lucide="save"></i>保存接口配置</button>
              </form>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h3>接口职责</h3></div>
            <div class="panel-body">
              <div class="compact-list">
                ${compactRow("交易接口", "下单、撤单、成交回报、委托查询")}
                ${compactRow("资金接口", "主账户现金、可用资金、冻结资金")}
                ${compactRow("持仓接口", "主账户总持仓、可卖数量、成本")}
                ${compactRow("行情接口", "最新价、买一卖一、涨跌停、行情时间")}
              </div>
            </div>
          </section>
        </div>
      </main>
    `;
  }

  function renderLogs() {
    return `
      <main class="content">
        <div class="split-grid">
          <section class="panel">
            <div class="panel-head"><h3>全部委托与成交</h3></div>
            ${renderOrdersTable(state.orders, { showTrader: true })}
          </section>
          <section class="panel">
            <div class="panel-head"><h3>操作日志</h3></div>
            <div class="panel-body">${renderAuditList()}</div>
          </section>
        </div>
      </main>
    `;
  }

  function renderTraderView(user) {
    if (ui.activeView === "positions") return renderTraderPositions(user);
    if (ui.activeView === "my-orders") return renderTraderOrders(user);
    if (ui.activeView === "pnl") return renderTraderPnl(user);
    if (ui.activeView === "rules") return renderTraderRules(user);
    return renderTraderTrade(user);
  }

  function renderTraderTrade(user) {
    return `
      <main class="content">
        ${renderTicker()}
        ${renderTraderMetrics(user)}
        <div class="trade-grid">
          <section class="panel">
            <div class="panel-head"><h3>股票池</h3></div>
            <div class="panel-body">${renderQuoteList()}</div>
          </section>

          <section class="panel">
            <div class="panel-head"><h3>下单</h3></div>
            <div class="panel-body">${renderOrderForm({ targetUser: user, formType: "trade-order" })}</div>
          </section>

          <section class="panel">
            <div class="panel-head"><h3>盘口</h3></div>
            <div class="panel-body">
              ${renderOrderBook(getQuote(ui.selectedSymbol))}
              <div class="compact-list" style="margin-top: 14px;">
                ${compactRow("可用资金", formatMoneyPlain(user.cash))}
                ${compactRow("可卖股数", formatQty(findPosition(user, ui.selectedSymbol)?.availableQty || 0))}
                ${compactRow("当前风控", state.settings.globalOpen ? "允许开仓" : "只允许卖出")}
              </div>
            </div>
          </section>
        </div>

        <div class="split-grid">
          <section class="panel">
            <div class="panel-head"><h3>持仓</h3></div>
            ${renderPositionsTable(user.positions, user)}
          </section>
          <section class="panel">
            <div class="panel-head"><h3>最近委托</h3></div>
            ${renderOrdersTable(getUserOrders(user.id).slice(0, 6), { showTrader: false })}
          </section>
        </div>
      </main>
    `;
  }

  function renderTraderPositions(user) {
    return `
      <main class="content">
        ${renderTraderMetrics(user)}
        <section class="panel">
          <div class="panel-head"><h3>我的持仓</h3></div>
          ${renderPositionsTable(user.positions, user)}
        </section>
      </main>
    `;
  }

  function renderTraderOrders(user) {
    return `
      <main class="content">
        <section class="panel">
          <div class="panel-head"><h3>我的委托与成交</h3></div>
          ${renderOrdersTable(getUserOrders(user.id), { showTrader: false })}
        </section>
      </main>
    `;
  }

  function renderTraderPnl(user) {
    const marketValue = getHoldingsValue(user);
    const pnl = getTraderTotalPnl(user);
    const exposure = user.capital > 0 ? (marketValue / user.capital) * 100 : 0;
    return `
      <main class="content">
        <div class="metric-grid">
          ${metric("总盈亏", signedMoney(pnl), "浮动 + 已实现，含费用", "chart-line", pnlClass(pnl))}
          ${metric("浮动盈亏", signedMoney(getFloatingPnl(user)), "按最新价估算", "activity", pnlClass(getFloatingPnl(user)))}
          ${metric("已实现盈亏", signedMoney(user.realizedPnL), "卖出成交后确认", "receipt-text", pnlClass(user.realizedPnL))}
          ${metric("累计费用", formatMoneyPlain(user.fees), "佣金 + 过户费 + 印花税", "coins")}
        </div>
        <section class="panel">
          <div class="panel-head"><h3>资金使用</h3></div>
          <div class="panel-body">
            <div class="three-col">
              ${miniRule("现金可用", formatMoneyPlain(user.cash), "未被委托预占的资金")}
              ${miniRule("持仓市值", formatMoneyPlain(marketValue), "按最新行情计算")}
              ${miniRule("仓位占比", `${exposure.toFixed(2)}%`, "持仓市值 / 虚拟资金")}
            </div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h3>盈亏明细</h3></div>
          ${renderPositionsTable(user.positions, user)}
        </section>
      </main>
    `;
  }

  function renderTraderRules(user) {
    const risk = state.settings.risk;
    return `
      <main class="content">
        <section class="panel">
          <div class="panel-head"><h3>当前规则</h3></div>
          <div class="panel-body">
            <div class="three-col">
              ${miniRule("单笔最大买入", formatMoneyPlain(risk.singleOrderMax), "超过后系统拦截")}
              ${miniRule("单只最大持仓", formatMoneyPlain(risk.singleStockMax), "按持仓市值计算")}
              ${miniRule("亏损限制", formatMoneyPlain(risk.dailyLossLimit), "触发后只允许卖出")}
              ${miniRule("价格偏离", `${risk.priceDeviationPct}%`, "买入对比卖一，卖出对比买一")}
              ${miniRule("行情过期", `${risk.quoteStaleSec} 秒`, "超时禁止下单")}
              ${miniRule("日内做T", state.settings.t0Mode ? "启用" : "关闭", "影响买入后是否立即可卖")}
            </div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h3>我的权限</h3></div>
          <div class="panel-body">
            <div class="compact-list">
              ${compactRow("账号状态", statusBadge(user.status))}
              ${compactRow("允许板块", state.settings.allowBoards.join("、") || "未配置")}
              ${compactRow("开仓状态", state.settings.globalOpen ? "允许买入" : "禁止买入，只能卖出")}
            </div>
          </div>
        </section>
      </main>
    `;
  }

  function renderTraderMetrics(user) {
    const equity = getTraderEquity(user);
    const pnl = getTraderTotalPnl(user);
    return `
      <div class="metric-grid">
        ${metric("虚拟总资产", formatMoneyPlain(equity), "现金 + 持仓市值", "wallet")}
        ${metric("可用资金", formatMoneyPlain(user.cash), "委托会先预占资金", "banknote")}
        ${metric("总盈亏", signedMoney(pnl), "展示口径已扣费用", "chart-line", pnlClass(pnl))}
        ${metric("持仓市值", formatMoneyPlain(getHoldingsValue(user)), `${user.positions.length} 只股票`, "briefcase-business")}
      </div>
    `;
  }

  function renderQuoteList() {
    return `
      <div class="quote-list">
        ${Object.values(state.market.quotes)
          .map((quote) => {
            const change = getChangePct(quote);
            return `
              <button class="quote-row ${ui.selectedSymbol === quote.symbol ? "active" : ""}" type="button" data-action="select-symbol" data-symbol="${quote.symbol}">
                <span class="quote-main">
                  <strong>${quote.symbol} ${h(quote.name)}</strong>
                  <span>${h(quote.board)} · 买一 ${quote.bid1.toFixed(2)} / 卖一 ${quote.ask1.toFixed(2)}</span>
                </span>
                <span class="quote-price">
                  <strong class="${pnlClass(change)}">${quote.last.toFixed(2)}</strong>
                  <span class="${pnlClass(change)}">${signedPercent(change)}</span>
                </span>
              </button>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function renderOrderForm({ targetUser, formType }) {
    const quote = getQuote(ui.selectedSymbol);
    const defaultPrice = ui.orderSide === "sell" ? quote.bid1 : quote.ask1;
    const position = findPosition(targetUser, ui.selectedSymbol);
    return `
      <form class="inline-form" data-form="${formType}">
        <input type="hidden" name="targetUserId" value="${targetUser.id}" />
        <div class="form-row">
          <label for="${formType}-symbol">股票代码</label>
          <select id="${formType}-symbol" name="symbol" data-control="symbol-select">${renderSymbolOptions(ui.selectedSymbol)}</select>
        </div>
        <div class="form-row two">
          <div>
            <label for="${formType}-side">方向</label>
            <select id="${formType}-side" name="side" data-control="order-side">
              ${option("buy", "买入", ui.orderSide === "buy")}
              ${option("sell", "卖出", ui.orderSide === "sell")}
            </select>
          </div>
          <div>
            <label for="${formType}-qty">数量</label>
            <input id="${formType}-qty" name="qty" type="number" min="100" step="100" value="1000" />
          </div>
        </div>
        <div class="form-row">
          <label for="${formType}-price">限价</label>
          <input id="${formType}-price" name="price" type="number" min="0.01" step="0.01" value="${defaultPrice.toFixed(2)}" />
        </div>
        <div class="compact-list">
          ${compactRow("最新价", quote.last.toFixed(2))}
          ${compactRow("买一 / 卖一", `${quote.bid1.toFixed(2)} / ${quote.ask1.toFixed(2)}`)}
          ${compactRow("持仓 / 可卖", `${formatQty(position?.qty || 0)} / ${formatQty(position?.availableQty || 0)}`)}
        </div>
        <button class="btn ${ui.orderSide === "buy" ? "btn-danger" : "btn-success"}" type="submit">
          <i data-lucide="send"></i>${ui.orderSide === "buy" ? "提交买入" : "提交卖出"}
        </button>
      </form>
    `;
  }

  function renderOrderBook(quote) {
    const levels = [
      ["卖三", round2(quote.ask1 + 0.04), 2600],
      ["卖二", round2(quote.ask1 + 0.02), 1800],
      ["卖一", quote.ask1, 1200],
      ["买一", quote.bid1, 1500],
      ["买二", round2(quote.bid1 - 0.02), 2100],
      ["买三", round2(quote.bid1 - 0.04), 2800]
    ];
    return `<div class="order-book">${levels.map(([label, price, qty]) => `<div class="book-row"><strong>${label}</strong><span class="number">${Number(price).toFixed(2)}</span><span class="number">${formatQty(qty)}</span></div>`).join("")}</div>`;
  }

  function renderManagerTable(managers) {
    return `
      <div class="table-wrap">
        <table>
          <thead><tr><th>账号</th><th>角色</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            ${managers
              .map(
                (user) => `
                  <tr>
                    <td><strong>${h(user.name)}</strong><br /><span class="hint">${h(user.username)}</span></td>
                    <td>${roleLabel(user.role)}</td>
                    <td>${statusBadge(user.status)}</td>
                    <td>${user.role === "boss" ? `<span class="hint">老板账号不可禁用</span>` : `<button class="btn btn-small" type="button" data-action="toggle-user" data-user-id="${user.id}"><i data-lucide="${user.status === "active" ? "ban" : "circle-play"}"></i>${user.status === "active" ? "禁用" : "启用"}</button>`}</td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderTraderTable(traders, withActions) {
    if (!traders.length) return `<div class="empty-state">暂无交易员</div>`;
    return `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>交易员</th><th>状态</th><th>虚拟资金</th><th>可用资金</th><th>总资产</th><th>盈亏</th><th>持仓</th>${withActions ? "<th>操作</th>" : ""}
            </tr>
          </thead>
          <tbody>
            ${traders
              .map((trader) => {
                const pnl = getTraderTotalPnl(trader);
                return `
                  <tr class="clickable" data-action="select-trader" data-trader-id="${trader.id}">
                    <td><strong>${h(trader.name)}</strong><br /><span class="hint">${h(trader.username)}</span></td>
                    <td>${statusBadge(trader.status)}</td>
                    <td class="number">${formatMoneyPlain(trader.capital)}</td>
                    <td class="number">${formatMoneyPlain(trader.cash)}</td>
                    <td class="number">${formatMoneyPlain(getTraderEquity(trader))}</td>
                    <td class="number ${pnlClass(pnl)}">${signedMoney(pnl)}</td>
                    <td>${trader.positions.length} 只</td>
                    ${
                      withActions
                        ? `<td><div class="toolbar"><button class="btn btn-small" type="button" data-action="open-modal" data-modal="managerTrade" data-trader-id="${trader.id}"><i data-lucide="send"></i>代下单</button><button class="btn btn-small" type="button" data-action="toggle-user" data-user-id="${trader.id}"><i data-lucide="${trader.status === "active" ? "ban" : "circle-play"}"></i>${trader.status === "active" ? "禁用" : "启用"}</button></div></td>`
                        : ""
                    }
                  </tr>
                `;
              })
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderTraderDetail(trader) {
    return `
      <div class="compact-list">
        ${compactRow("账户", `${h(trader.name)} / ${h(trader.username)}`)}
        ${compactRow("状态", statusBadge(trader.status))}
        ${compactRow("虚拟资金", formatMoneyPlain(trader.capital))}
        ${compactRow("可用资金", formatMoneyPlain(trader.cash))}
        ${compactRow("持仓市值", formatMoneyPlain(getHoldingsValue(trader)))}
        ${compactRow("总盈亏", `<span class="${pnlClass(getTraderTotalPnl(trader))}">${signedMoney(getTraderTotalPnl(trader))}</span>`)}
        ${compactRow("累计费用", formatMoneyPlain(trader.fees))}
      </div>
      <div style="margin-top: 16px;">${renderPositionsTable(trader.positions, trader, true)}</div>
    `;
  }

  function renderMainHoldingsTable(holdings) {
    if (!holdings.length) return `<div class="empty-state">暂无主账户底仓</div>`;
    return `
      <div class="table-wrap">
        <table>
          <thead><tr><th>股票</th><th>板块</th><th>总持仓</th><th>未分配</th><th>已分配</th><th>成本</th><th>最新</th><th>市值</th><th>浮盈亏</th></tr></thead>
          <tbody>
            ${holdings
              .map((holding) => {
                const quote = getQuote(holding.symbol);
                const latest = quote.last;
                const value = round2(holding.qty * latest);
                const allocated = Math.max(0, holding.qty - holding.availableQty);
                const floating = round2((latest - holding.avgCost) * holding.qty);
                return `<tr><td><strong>${holding.symbol}</strong><br /><span class="hint">${h(holding.name)}</span></td><td>${h(holding.board)}</td><td class="number">${formatQty(holding.qty)}</td><td class="number">${formatQty(holding.availableQty)}</td><td class="number">${formatQty(allocated)}</td><td class="number">${holding.avgCost.toFixed(3)}</td><td class="number">${latest.toFixed(2)}</td><td class="number">${formatMoneyPlain(value)}</td><td class="number ${pnlClass(floating)}">${signedMoney(floating)}</td></tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderAllocationTable(records) {
    if (!records.length) return `<div class="empty-state">暂无分配记录</div>`;
    return `
      <div class="table-wrap">
        <table>
          <thead><tr><th>时间</th><th>类型</th><th>交易员</th><th>股票</th><th>数量</th><th>金额变化</th><th>操作人</th><th>备注</th></tr></thead>
          <tbody>
            ${records
              .map((record) => `<tr><td class="number">${formatTime(record.time)}</td><td>${h(record.type)}</td><td>${h(record.traderName)}</td><td>${record.symbol === "-" ? "-" : `<strong>${record.symbol}</strong><br /><span class="hint">${h(record.name)}</span>`}</td><td class="number">${record.qty ? formatQty(record.qty) : "-"}</td><td class="number ${pnlClass(record.amount)}">${record.amount ? signedMoney(record.amount) : "-"}</td><td>${h(record.operator)}</td><td>${h(record.note)}</td></tr>`)
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderPositionsTable(positions, trader, compact = false) {
    if (!positions.length) return `<div class="empty-state">暂无持仓</div>`;
    return `
      <div class="table-wrap">
        <table>
          <thead><tr><th>股票</th><th>板块</th><th>持仓</th><th>可卖</th><th>成本</th><th>最新</th><th>市值</th><th>浮盈亏</th>${compact ? "" : "<th>操作</th>"}</tr></thead>
          <tbody>
            ${positions
              .map((position) => {
                const quote = getQuote(position.symbol);
                const latest = quote.last;
                const value = position.qty * latest;
                const floating = getPositionPnl(position);
                return `
                  <tr>
                    <td><strong>${position.symbol}</strong><br /><span class="hint">${h(position.name)}</span></td>
                    <td>${h(position.board)}</td>
                    <td class="number">${formatQty(position.qty)}</td>
                    <td class="number">${formatQty(position.availableQty)}</td>
                    <td class="number">${position.avgCost.toFixed(3)}</td>
                    <td class="number">${latest.toFixed(2)}</td>
                    <td class="number">${formatMoneyPlain(value)}</td>
                    <td class="number ${pnlClass(floating)}">${signedMoney(floating)}</td>
                    ${compact ? "" : `<td><button class="btn btn-small" type="button" data-action="prefill-sell" data-symbol="${position.symbol}"><i data-lucide="send"></i>卖出</button></td>`}
                  </tr>
                `;
              })
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderOrdersTable(orders, { showTrader }) {
    if (!orders.length) return `<div class="empty-state">暂无委托记录</div>`;
    return `
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>时间</th>${showTrader ? "<th>交易员</th>" : ""}<th>股票</th><th>方向</th><th>价格</th><th>数量</th><th>金额</th><th>费用</th><th>状态</th><th>来源</th><th>操作</th></tr>
          </thead>
          <tbody>
            ${orders
              .map(
                (order) => `
                  <tr>
                    <td class="number">${formatTime(order.createdAt)}</td>
                    ${showTrader ? `<td>${h(order.traderName)}</td>` : ""}
                    <td><strong>${order.symbol}</strong><br /><span class="hint">${h(order.name)}</span></td>
                    <td>${sideBadge(order.side)}</td>
                    <td class="number">${order.price.toFixed(2)}</td>
                    <td class="number">${formatQty(order.qty)}</td>
                    <td class="number">${formatMoneyPlain(order.amount)}</td>
                    <td class="number">${formatMoneyPlain(order.fee)}</td>
                    <td>${orderStatusBadge(order.status)}</td>
                    <td>${h(order.source)}</td>
                    <td>${order.status === "已报" ? `<button class="btn btn-small" type="button" data-action="cancel-order" data-order-id="${order.id}"><i data-lucide="x"></i>撤单</button>` : `<span class="hint">-</span>`}</td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderRiskAlerts() {
    const alerts = [];
    if (!state.settings.globalOpen) alerts.push(["全局禁止开仓", "所有交易员只能卖出，不能新增买入委托。", "ban"]);
    const main = getMainAccountMetrics();
    if (state.mainAccount.cash < 100000) alerts.push(["主账户现金偏低", "主账户现金不足会拦截实盘买入。", "wallet"]);
    if (main.unallocatedQty <= 0) alerts.push(["未分配底仓不足", "底仓分配前需要先同步或维护主账户持仓。", "database"]);
    getTraders().forEach((trader) => {
      const pnl = getTraderTotalPnl(trader);
      if (trader.status !== "active") alerts.push([`${trader.name} 已禁用`, "交易员只能查看，不能下单。", "user-x"]);
      if (pnl <= -Math.abs(state.settings.risk.dailyLossLimit) * 0.8) alerts.push([`${trader.name} 接近亏损限制`, `当前盈亏 ${signedMoney(pnl)}。`, "triangle-alert"]);
    });
    const pending = state.orders.filter((order) => order.status === "已报").length;
    if (pending) alerts.push(["存在已报委托", `${pending} 笔委托等待模拟成交或撤单。`, "clock"]);
    if (!alerts.length) alerts.push(["暂无风险触发", "账号、主账户底仓、委托和盈亏均在规则范围内。", "shield-check"]);
    return `<div class="risk-list">${alerts.map(([title, body, icon]) => `<div class="risk-item"><span class="risk-icon"><i data-lucide="${icon}"></i></span><div><strong>${h(title)}</strong><span>${h(body)}</span></div></div>`).join("")}</div>`;
  }

  function renderAuditList() {
    if (!state.audit.length) return `<div class="empty-state">暂无日志</div>`;
    return `<div class="audit-list">${state.audit.slice(0, 30).map((entry) => `<div class="audit-item"><span class="audit-icon"><i data-lucide="activity"></i></span><div><strong>${h(entry.type)} · ${formatTime(entry.time)} · ${h(entry.operator || "系统")}</strong><span>${h(entry.message)}</span></div></div>`).join("")}</div>`;
  }

  function renderTicker() {
    return `<div class="ticker">${Object.values(state.market.quotes).slice(0, 6).map((quote) => `<span class="ticker-item"><strong>${quote.symbol}</strong><span>${h(quote.name)}</span><span class="${pnlClass(getChangePct(quote))}">${quote.last.toFixed(2)} ${signedPercent(getChangePct(quote))}</span></span>`).join("")}</div>`;
  }

  function renderModal() {
    if (!ui.modal) return "";
    if (ui.modal.type === "createUser") {
      return `
        <div class="modal-backdrop">
          <section class="modal" role="dialog" aria-modal="true" aria-label="新建账号">
            <div class="modal-head">
              <h3>新建账号</h3>
              <button class="btn btn-small" type="button" data-action="close-modal"><i data-lucide="x"></i>关闭</button>
            </div>
            <div class="modal-body">
              <form class="inline-form" data-form="create-user">
                <div class="form-row">
                  <label for="modal-user-role">账号角色</label>
                  <select id="modal-user-role" name="role">
                    ${option("trader", "交易员", true)}
                    ${option("admin", "管理员", false)}
                  </select>
                </div>
                <div class="form-row two">
                  <div>
                    <label for="modal-user-name">姓名</label>
                    <input id="modal-user-name" name="name" required />
                  </div>
                  <div>
                    <label for="modal-user-username">用户名</label>
                    <input id="modal-user-username" name="username" required />
                  </div>
                </div>
                <div class="form-row two">
                  <div>
                    <label for="modal-user-password">初始密码</label>
                    <input id="modal-user-password" name="password" type="password" value="123456" required />
                  </div>
                  <div>
                    <label for="modal-user-capital">交易员虚拟资金</label>
                    <input id="modal-user-capital" name="capital" type="number" min="0" step="10000" value="500000" />
                  </div>
                </div>
                <button class="btn btn-primary" type="submit"><i data-lucide="user-plus"></i>创建账号</button>
              </form>
            </div>
          </section>
        </div>
      `;
    }
    if (ui.modal.type === "managerTrade") {
      const trader = getUser(ui.modal.traderId) || getTraders()[0];
      return `
        <div class="modal-backdrop">
          <section class="modal" role="dialog" aria-modal="true" aria-label="管理端代下单">
            <div class="modal-head">
              <h3>代 ${trader ? h(trader.name) : "交易员"} 下单</h3>
              <button class="btn btn-small" type="button" data-action="close-modal"><i data-lucide="x"></i>关闭</button>
            </div>
            <div class="modal-body">${trader ? renderOrderForm({ targetUser: trader, formType: "manager-order" }) : `<div class="empty-state">暂无交易员</div>`}</div>
          </section>
        </div>
      `;
    }
    return "";
  }

  function metric(label, value, foot, icon, valueClass = "") {
    return `<div class="metric"><div class="metric-label"><i data-lucide="${icon}"></i>${h(label)}</div><div class="metric-value ${valueClass}">${value}</div><div class="metric-foot">${h(foot)}</div></div>`;
  }

  function miniRule(title, value, note) {
    return `<div class="metric"><div class="metric-label">${h(title)}</div><div class="metric-value" style="font-size: 18px;">${value}</div><div class="metric-foot">${h(note)}</div></div>`;
  }

  function compactRow(label, value) {
    return `<div class="compact-row"><span>${h(label)}</span><strong>${value}</strong></div>`;
  }

  function renderSymbolOptions(selectedSymbol) {
    return Object.values(state.market.quotes).map((quote) => option(quote.symbol, `${quote.symbol} ${quote.name} · ${quote.board}`, selectedSymbol === quote.symbol)).join("");
  }

  function renderMainHoldingOptions(selectedSymbol) {
    const holdings = state.mainAccount.holdings.length ? state.mainAccount.holdings : Object.values(state.market.quotes).slice(0, 1);
    return holdings.map((holding) => option(holding.symbol, `${holding.symbol} ${holding.name} · 未分配 ${formatQty(holding.availableQty || 0)}`, selectedSymbol === holding.symbol)).join("");
  }

  function option(value, label, selected) {
    return `<option value="${h(value)}" ${selected ? "selected" : ""}>${h(label)}</option>`;
  }

  function getGlobalMetrics() {
    const traders = getTraders();
    return {
      capital: traders.reduce((sum, trader) => sum + trader.capital, 0),
      equity: traders.reduce((sum, trader) => sum + getTraderEquity(trader), 0),
      pnl: traders.reduce((sum, trader) => sum + getTraderTotalPnl(trader), 0),
      pendingOrders: state.orders.filter((order) => order.status === "已报").length
    };
  }

  function getMainAccountMetrics() {
    const holdingsValue = getMainHoldingsValue();
    const unallocatedValue = state.mainAccount.holdings.reduce((sum, holding) => sum + holding.availableQty * getQuote(holding.symbol).last, 0);
    const unallocatedQty = state.mainAccount.holdings.reduce((sum, holding) => sum + holding.availableQty, 0);
    return {
      equity: round2(state.mainAccount.cash + holdingsValue),
      holdingsValue: round2(holdingsValue),
      unallocatedValue: round2(unallocatedValue),
      unallocatedQty
    };
  }

  function getCurrentUser() {
    return getUser(state.currentUserId);
  }

  function getUser(id) {
    return state.users.find((user) => user.id === id) || null;
  }

  function getManagers() {
    return state.users.filter((user) => isManagementRole(user.role));
  }

  function getTraders() {
    return state.users.filter((user) => user.role === "trader");
  }

  function getQuote(symbol) {
    return state.market.quotes[String(symbol)] || Object.values(state.market.quotes)[0];
  }

  function getQuoteFromState(sourceState, symbol) {
    return sourceState.market.quotes[String(symbol)] || Object.values(sourceState.market.quotes)[0];
  }

  function getOrder(id) {
    return state.orders.find((order) => order.id === id) || null;
  }

  function findPosition(trader, symbol) {
    return trader.positions.find((position) => position.symbol === symbol) || null;
  }

  function findMainHolding(symbol) {
    return state.mainAccount.holdings.find((holding) => holding.symbol === String(symbol)) || null;
  }

  function getPositionValue(trader, symbol) {
    const position = findPosition(trader, symbol);
    if (!position) return 0;
    return round2(position.qty * getQuote(symbol).last);
  }

  function getPositionPnl(position) {
    const latest = getQuote(position.symbol).last;
    return round2((latest - position.avgCost) * position.qty);
  }

  function getFloatingPnl(trader) {
    return round2(trader.positions.reduce((sum, position) => sum + getPositionPnl(position), 0));
  }

  function getTraderTotalPnl(trader) {
    return round2((trader.realizedPnL || 0) + getFloatingPnl(trader));
  }

  function getHoldingsValue(trader) {
    return round2(trader.positions.reduce((sum, position) => sum + position.qty * getQuote(position.symbol).last, 0));
  }

  function getMainHoldingsValue() {
    return round2(state.mainAccount.holdings.reduce((sum, holding) => sum + holding.qty * getQuote(holding.symbol).last, 0));
  }

  function getTraderEquity(trader) {
    return round2(trader.cash + getHoldingsValue(trader));
  }

  function getUserOrders(userId) {
    return state.orders.filter((order) => order.userId === userId);
  }

  function getTodayOrders(userId) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return state.orders.filter((order) => order.userId === userId && order.createdAt >= start.getTime() && order.status !== "已撤");
  }

  function calcFees(side, value) {
    const fees = state.settings.fees;
    const commission = Math.max(5, value * fees.commissionRate);
    const transfer = value * fees.transferRate;
    const stamp = side === "sell" ? value * fees.stampTaxRate : 0;
    return round2(commission + transfer + stamp);
  }

  function addAudit(type, message) {
    const user = getCurrentUser();
    state.audit.unshift({
      id: makeId("audit"),
      time: Date.now(),
      type,
      operator: user ? user.name : "系统",
      message
    });
    state.audit = state.audit.slice(0, 120);
  }

  function ensureUiDefaults() {
    if (!state) return;
    const current = getCurrentUser();
    if (!Object.keys(state.market.quotes).includes(ui.selectedSymbol)) ui.selectedSymbol = Object.keys(state.market.quotes)[0];
    if (!ui.orderSide) ui.orderSide = "buy";
    if (isManagementUser(current)) {
      const traders = getTraders();
      if (!traders.some((trader) => trader.id === ui.selectedTraderId)) ui.selectedTraderId = traders[0]?.id || null;
      const views = getNav(current.role).map((item) => item.id);
      if (!views.includes(ui.activeView)) ui.activeView = "overview";
    }
    if (current?.role === "trader") {
      ui.selectedTraderId = current.id;
      const views = getNav("trader").map((item) => item.id);
      if (!views.includes(ui.activeView)) ui.activeView = "trade";
    }
  }

  function isManagementRole(role) {
    return role === "boss" || role === "admin";
  }

  function isManagementUser(user) {
    return !!user && isManagementRole(user.role);
  }

  function formatMoneyPlain(value) {
    return Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function signedMoney(value) {
    const number = Number(value || 0);
    return `${number > 0 ? "+" : ""}${formatMoneyPlain(number)}`;
  }

  function signedPercent(value) {
    const number = Number(value || 0);
    return `${number > 0 ? "+" : ""}${number.toFixed(2)}%`;
  }

  function formatQty(value) {
    return Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 0 });
  }

  function formatTime(ts) {
    if (!ts) return "-";
    return new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  }

  function getChangePct(quote) {
    return ((quote.last - quote.prevClose) / quote.prevClose) * 100;
  }

  function pnlClass(value) {
    if (Number(value) > 0) return "positive";
    if (Number(value) < 0) return "negative";
    return "neutral";
  }

  function statusText(status) {
    return status === "active" ? "启用" : "禁用";
  }

  function statusBadge(status) {
    return `<span class="badge ${status === "active" ? "good" : "danger"}">${statusText(status)}</span>`;
  }

  function sideText(side) {
    return side === "buy" ? "买入" : "卖出";
  }

  function sideBadge(side) {
    return `<span class="badge ${side === "buy" ? "danger" : "good"}">${sideText(side)}</span>`;
  }

  function orderStatusBadge(status) {
    const cls = status === "全部成交" ? "good" : status === "已报" ? "warn" : status === "废单" ? "danger" : "info";
    return `<span class="badge ${cls}">${h(status)}</span>`;
  }

  function roleLabel(role) {
    if (role === "boss") return "老板";
    if (role === "admin") return "管理员";
    return "交易员";
  }

  function validLot(qty) {
    return Number.isFinite(qty) && qty > 0 && qty % LOT_SIZE === 0;
  }

  function makeId(prefix) {
    if (window.crypto && crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function round2(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }

  function round4(value) {
    return Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
  }

  function h(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function showToast(message, icon = "info") {
    const stack = document.getElementById("toast-stack");
    if (!stack) return;
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `<i data-lucide="${icon}"></i><span>${h(message)}</span>`;
    stack.appendChild(toast);
    if (window.lucide) window.lucide.createIcons();
    setTimeout(() => toast.remove(), 2600);
  }
})();
