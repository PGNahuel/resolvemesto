function auditData(value) {
  if(value===null)return null;
  return JSON.parse(JSON.stringify(value,(key,item)=>['profile_photo','photo','logo'].includes(key)&&item?'[imagen]':item));
}

export class Repository {
  constructor(db) { this.db=db; }

  transaction(work) {
    this.db.exec('BEGIN');
    try { const result=work(); this.db.exec('COMMIT'); return result; }
    catch(error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }

  close() { this.db.close(); }

  createUser({name,email,passwordHash,profilePhoto=null}) {
    return Number(this.db.prepare('INSERT INTO users(name,email,password_hash,profile_photo) VALUES(?,?,?,?)').run(name,email,passwordHash,profilePhoto).lastInsertRowid);
  }

  findUserByEmail(email) { return this.db.prepare('SELECT * FROM users WHERE email=?').get(email)||null; }
  findUserPassword(userId) { return this.db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId)||null; }
  getPublicUser(userId) { return this.db.prepare('SELECT id,name,email,profile_photo FROM users WHERE id=?').get(userId)||null; }
  updateUserPassword(userId,passwordHash) { this.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash,userId); }
  updateUserPhoto(userId,profilePhoto) { this.db.prepare('UPDATE users SET profile_photo=? WHERE id=?').run(profilePhoto,userId); }

  createSession(token,userId,expiresAt) { this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token,userId,expiresAt); }
  findSession(hashedToken,rawToken,now) { return this.db.prepare('SELECT user_id FROM sessions WHERE token IN (?,?) AND expires_at>?').get(hashedToken,rawToken,now)||null; }
  deleteSessionsByTokens(hashedToken,rawToken) { this.db.prepare('DELETE FROM sessions WHERE token IN (?,?)').run(hashedToken,rawToken); }
  deleteSessionsByUser(userId) { this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId); }

  createBusiness(name) { return Number(this.db.prepare('INSERT INTO businesses(name) VALUES(?)').run(name).lastInsertRowid); }
  getBusinessData(businessId) { return this.db.prepare('SELECT name,logo FROM businesses WHERE id=?').get(businessId)||null; }
  updateBusiness(businessId,{name,logo}) { this.db.prepare('UPDATE businesses SET name=?,logo=? WHERE id=?').run(name,logo,businessId); }
  findBusinessMembership(businessId,userId) { return this.db.prepare('SELECT b.id,b.name,b.logo,e.role,e.id employee_id FROM businesses b JOIN employees e ON e.business_id=b.id WHERE b.id=? AND e.user_id=?').get(businessId,userId)||null; }
  listUserBusinesses(userId) { return this.db.prepare('SELECT b.id,b.name,b.logo,e.role,e.id employee_id FROM businesses b JOIN employees e ON e.business_id=b.id WHERE e.user_id=? ORDER BY b.name').all(userId); }

  addEmployee(businessId,userId,role) { return Number(this.db.prepare('INSERT INTO employees(business_id,user_id,role) VALUES(?,?,?)').run(businessId,userId,role).lastInsertRowid); }
  findEmployee(employeeId,businessId) { return this.db.prepare('SELECT id FROM employees WHERE id=? AND business_id=?').get(employeeId,businessId)||null; }
  listEmployees(businessId) { return this.db.prepare('SELECT e.id,e.user_id,e.role,u.name,u.email,u.profile_photo FROM employees e JOIN users u ON u.id=e.user_id WHERE e.business_id=? ORDER BY e.role,u.name').all(businessId); }

  listCustomers(businessId) {
    return this.db.prepare(`SELECT c.id,c.full_name,c.phone,c.email,c.profile_photo,MAX(s.created_at) last_operation
      FROM customers c LEFT JOIN sales s ON s.customer_id=c.id
      WHERE c.business_id=? GROUP BY c.id ORDER BY c.full_name COLLATE NOCASE`).all(businessId);
  }
  findCustomer(customerId,businessId) { return this.db.prepare('SELECT id FROM customers WHERE id=? AND business_id=?').get(customerId,businessId)||null; }
  getCustomer(customerId,businessId) { return this.db.prepare('SELECT full_name,phone,email,profile_photo FROM customers WHERE id=? AND business_id=?').get(customerId,businessId)||null; }
  createCustomer(businessId,{fullName,phone,email,profilePhoto}) { return Number(this.db.prepare('INSERT INTO customers(business_id,full_name,phone,email,profile_photo) VALUES(?,?,?,?,?)').run(businessId,fullName,phone,email,profilePhoto).lastInsertRowid); }
  updateCustomer(customerId,businessId,{fullName,phone,email,profilePhoto}) { this.db.prepare('UPDATE customers SET full_name=?,phone=?,email=?,profile_photo=? WHERE id=? AND business_id=?').run(fullName,phone,email,profilePhoto,customerId,businessId); }

  listCatalog(businessId,includeInactive) {
    return this.db.prepare(`SELECT id,type,name,price,active,photo FROM catalog WHERE business_id=? ${includeInactive?'':'AND active=1'} ORDER BY active DESC,type,name`).all(businessId);
  }
  findCatalogItem(itemId,businessId,{activeOnly=false}={}) { return this.db.prepare(`SELECT id,name,type,price${activeOnly?'':',active,photo'} FROM catalog WHERE id=? AND business_id=? ${activeOnly?'AND active=1':''}`).get(itemId,businessId)||null; }
  getCatalogItem(itemId,businessId) { return this.db.prepare('SELECT id,type,name,price,active,photo FROM catalog WHERE id=? AND business_id=?').get(itemId,businessId)||null; }
  findCatalogDuplicate(businessId,type,name,excludeId=null) {
    return excludeId===null
      ? this.db.prepare('SELECT id FROM catalog WHERE business_id=? AND type=? AND lower(name)=lower(?)').get(businessId,type,name)||null
      : this.db.prepare('SELECT id FROM catalog WHERE business_id=? AND type=? AND lower(name)=lower(?) AND id<>?').get(businessId,type,name,excludeId)||null;
  }
  createCatalogItem(businessId,{type,name,price,photo}) { return Number(this.db.prepare('INSERT INTO catalog(business_id,type,name,price,photo) VALUES(?,?,?,?,?)').run(businessId,type,name,price,photo).lastInsertRowid); }
  updateCatalogItem(itemId,businessId,{name,price,active,photo}) { this.db.prepare('UPDATE catalog SET name=?,price=?,active=?,photo=? WHERE id=? AND business_id=?').run(name,price,active,photo,itemId,businessId); }
  deactivateCatalogItem(itemId,businessId) { this.db.prepare('UPDATE catalog SET active=0 WHERE id=? AND business_id=?').run(itemId,businessId); }
  catalogHistoryImpact(itemId,businessId,start,end) { return this.db.prepare(`SELECT COUNT(DISTINCT s.id) sales,COUNT(si.id) items FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE si.catalog_id=? AND s.business_id=? AND date(s.created_at,'-3 hours') BETWEEN ? AND ?`).get(itemId,businessId,start,end); }

  createSale(data) {
    return Number(this.db.prepare(`INSERT INTO sales(business_id,employee_id,customer,customer_id,created_by_employee_id,payment_method,discount,notes,status)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(data.businessId,data.employeeId,null,data.customerId,data.createdByEmployeeId,data.paymentMethod,data.discount,data.notes,'completed').lastInsertRowid);
  }
  insertSaleItems(saleId,items) {
    const insert=this.db.prepare('INSERT INTO sale_items(sale_id,catalog_id,item_name,item_type,quantity,unit_price) VALUES(?,?,?,?,?,?)');
    for(const item of items)insert.run(saleId,item.id,item.name,item.type,item.qty,item.price);
  }
  replaceSaleItems(saleId,items) { this.db.prepare('DELETE FROM sale_items WHERE sale_id=?').run(saleId); this.insertSaleItems(saleId,items); }
  updateSale(saleId,businessId,data) { this.db.prepare('UPDATE sales SET employee_id=?,customer_id=?,customer=NULL,payment_method=?,discount=?,notes=? WHERE id=? AND business_id=?').run(data.employeeId,data.customerId,data.paymentMethod,data.discount,data.notes,saleId,businessId); }
  voidSale(saleId,businessId,reason) { this.db.prepare("UPDATE sales SET status='voided',void_reason=?,voided_at=CURRENT_TIMESTAMP WHERE id=? AND business_id=?").run(reason,saleId,businessId); }
  findSaleOwner(saleId,businessId) { return this.db.prepare('SELECT id,employee_id,status,COALESCE(created_by_employee_id,employee_id) created_by_employee_id FROM sales WHERE id=? AND business_id=?').get(saleId,businessId)||null; }
  salePrices(saleId) { return this.db.prepare('SELECT catalog_id,unit_price FROM sale_items WHERE sale_id=?').all(saleId); }
  saleSnapshot(saleId,businessId) {
    const sale=this.db.prepare('SELECT id,employee_id,customer_id,payment_method,discount,notes,status,void_reason,voided_at,created_at FROM sales WHERE id=? AND business_id=?').get(saleId,businessId);
    if(!sale)return null;
    return {...sale,items:this.db.prepare('SELECT catalog_id,item_name,item_type,quantity,unit_price FROM sale_items WHERE sale_id=? ORDER BY id').all(saleId)};
  }
  listSales(businessId,isAdmin,employeeId) {
    return this.db.prepare(`SELECT s.id,s.created_at,s.customer_id,s.payment_method,s.discount,s.status,s.notes,s.void_reason,
      COALESCE(c.full_name,s.customer,'Sin cliente') customer,u.name employee,
      MAX(0,COALESCE(SUM(si.quantity*si.unit_price),0)-s.discount) total,
      GROUP_CONCAT(si.item_name||' ×'||si.quantity,', ') items,
      ((? OR COALESCE(s.created_by_employee_id,s.employee_id)=?) AND s.status='completed') editable
      FROM sales s JOIN employees e ON e.id=s.employee_id JOIN users u ON u.id=e.user_id
      LEFT JOIN customers c ON c.id=s.customer_id JOIN sale_items si ON si.sale_id=s.id
      WHERE s.business_id=? GROUP BY s.id ORDER BY s.created_at DESC`).all(isAdmin?1:0,employeeId,businessId);
  }
  getSale(saleId,businessId,isAdmin,employeeId) {
    const sale=this.db.prepare(`SELECT s.id,s.created_at,s.customer_id,s.employee_id,s.payment_method,s.discount,s.notes,s.status,s.void_reason,s.voided_at,
      COALESCE(c.full_name,s.customer,'Sin cliente') customer,u.name employee,
      ((? OR COALESCE(s.created_by_employee_id,s.employee_id)=?) AND s.status='completed') editable
      FROM sales s JOIN employees e ON e.id=s.employee_id JOIN users u ON u.id=e.user_id LEFT JOIN customers c ON c.id=s.customer_id
      WHERE s.id=? AND s.business_id=?`).get(isAdmin?1:0,employeeId,saleId,businessId);
    if(!sale)return null;
    sale.items=this.db.prepare('SELECT catalog_id id,item_name name,item_type type,quantity,unit_price price FROM sale_items WHERE sale_id=? ORDER BY id').all(saleId);
    return sale;
  }

  addAudit({businessId,actorUserId,actorEmployeeId,action,entityType,entityId,before=null,after=null}) {
    this.db.prepare(`INSERT INTO audit_logs(business_id,actor_user_id,actor_employee_id,action,entity_type,entity_id,before_json,after_json)
      VALUES(?,?,?,?,?,?,?,?)`).run(businessId,actorUserId,actorEmployeeId,action,entityType,entityId??null,before===null?null:JSON.stringify(auditData(before)),after===null?null:JSON.stringify(auditData(after)));
  }
  listAudit(businessId) {
    return this.db.prepare(`SELECT a.id,a.action,a.entity_type,a.entity_id,a.before_json,a.after_json,a.created_at,COALESCE(u.name,'Sistema') actor
      FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id WHERE a.business_id=? ORDER BY a.id DESC LIMIT 100`).all(businessId);
  }

  firstSaleDate(businessId) { return this.db.prepare("SELECT MIN(date(created_at,'-3 hours')) date FROM sales WHERE business_id=? AND status='completed'").get(businessId).date||null; }
  dashboardSummary(businessId,start,end) {
    return this.db.prepare(`WITH ticket_totals AS (
      SELECT s.id,MAX(0,SUM(si.quantity*si.unit_price)-s.discount) total,
      SUM(CASE WHEN si.item_type='service' THEN si.quantity ELSE 0 END) services,
      SUM(CASE WHEN si.item_type='product' THEN si.quantity ELSE 0 END) products
      FROM sales s JOIN sale_items si ON si.sale_id=s.id
      WHERE s.business_id=? AND s.status='completed' AND date(s.created_at,'-3 hours') BETWEEN ? AND ? GROUP BY s.id)
      SELECT COALESCE(SUM(total),0) revenue,COALESCE(SUM(services),0) services,COALESCE(SUM(products),0) products,COUNT(*) tickets FROM ticket_totals`).get(businessId,start,end);
  }
  dashboardPrevious(businessId,start,span) {
    return this.db.prepare(`WITH ticket_totals AS (
      SELECT s.id,MAX(0,SUM(si.quantity*si.unit_price)-s.discount) total FROM sales s JOIN sale_items si ON si.sale_id=s.id
      WHERE s.business_id=? AND s.status='completed' AND date(s.created_at,'-3 hours')>=date(?,'-' || ? || ' days') AND date(s.created_at,'-3 hours')<? GROUP BY s.id)
      SELECT COALESCE(SUM(total),0) revenue,COUNT(*) tickets FROM ticket_totals`).get(businessId,start,span,start);
  }
  dashboardEmployees(businessId,start,end) {
    return this.db.prepare(`SELECT u.name,u.profile_photo,COUNT(DISTINCT s.id) tickets,
      COALESCE(SUM(CASE WHEN si.item_type='service' THEN si.quantity ELSE 0 END),0) services,
      COALESCE(SUM(CASE WHEN si.item_type='product' THEN si.quantity ELSE 0 END),0) products,
      (SELECT COALESCE(SUM(total),0) FROM (SELECT MAX(0,SUM(si2.quantity*si2.unit_price)-s2.discount) total
        FROM sales s2 JOIN sale_items si2 ON si2.sale_id=s2.id WHERE s2.employee_id=e.id AND s2.status='completed'
        AND date(s2.created_at,'-3 hours') BETWEEN ? AND ? GROUP BY s2.id)) revenue
      FROM employees e JOIN users u ON u.id=e.user_id
      LEFT JOIN sales s ON s.employee_id=e.id AND s.status='completed' AND date(s.created_at,'-3 hours') BETWEEN ? AND ?
      LEFT JOIN sale_items si ON si.sale_id=s.id WHERE e.business_id=? GROUP BY e.id ORDER BY revenue DESC`).all(start,end,start,end,businessId);
  }
  dashboardFeatured(businessId,start,end) {
    return this.db.prepare(`SELECT si.item_name name,si.item_type type,SUM(si.quantity) quantity,SUM(si.quantity*si.unit_price) revenue
      FROM sales s JOIN sale_items si ON si.sale_id=s.id WHERE s.business_id=? AND s.status='completed'
      AND date(s.created_at,'-3 hours') BETWEEN ? AND ? GROUP BY si.catalog_id ORDER BY revenue DESC`).all(businessId,start,end);
  }
  dashboardRecent(businessId,start,end) {
    return this.db.prepare(`SELECT s.id,COALESCE(c.full_name,s.customer) customer,s.created_at,u.name employee,u.profile_photo,
      MAX(0,COALESCE(SUM(si.quantity*si.unit_price),0)-s.discount) total,GROUP_CONCAT(si.item_name||' ×'||si.quantity,', ') items
      FROM sales s JOIN employees e ON e.id=s.employee_id JOIN users u ON u.id=e.user_id
      LEFT JOIN customers c ON c.id=s.customer_id JOIN sale_items si ON si.sale_id=s.id
      WHERE s.business_id=? AND s.status='completed' AND date(s.created_at,'-3 hours') BETWEEN ? AND ?
      GROUP BY s.id ORDER BY s.created_at DESC LIMIT 5`).all(businessId,start,end);
  }
}
