"""
Seed the database with the mock data from erp-cyber-terminal.html.

Usage:
    python -m app.seed
"""
from datetime import date

from app.core.security import hash_password
from app.database import SessionLocal, engine
from app.models import Batch, Material, Transaction, User
from app.database import Base


def run():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        if db.query(User).count() > 0:
            print("Database already seeded — skipping.")
            return

        # ── users ─────────────────────────────────────────────────────────
        users = [
            User(username="admin",   full_name="系统管理员",  role="admin",    hashed_password=hash_password("admin123")),
            User(username="manager", full_name="库存经理",    role="manager",  hashed_password=hash_password("manager123")),
            User(username="op01",    full_name="操作员 张三", role="operator", hashed_password=hash_password("op123")),
        ]
        db.add_all(users)

        # ── materials ─────────────────────────────────────────────────────
        materials_data = [
            dict(id="MAT-0472", name_cn="阴离子交换层析介质", name_en="Capto Q Impress",
                 sku="17547002", spec="100mL", unit="瓶", cur_stock=2, safe_stock=8,
                 price=3280, cond="4°C", category="层析填料",
                 supplier="Cytiva", maker="Cytiva Sweden AB", country="SE"),
            dict(id="MAT-0015", name_cn="乙二胺四乙酸二钠", name_en="EDTA-Na₂",
                 sku="—", spec="250g", unit="瓶", cur_stock=1, safe_stock=2,
                 price=218, cond="室温", category="缓冲液组分",
                 supplier="国药沪试", maker="Sinopharm Chemical Reagent Co., Ltd", country="CN"),
            dict(id="MAT-0318", name_cn="质粒纯化介质", name_en="PlasmidSelect Xtra",
                 sku="28402403", spec="1L", unit="桶", cur_stock=1.8, safe_stock=4,
                 price=12800, cond="4°C", category="层析填料",
                 supplier="Cytiva", maker="Cytiva Sweden AB", country="SE"),
            dict(id="MAT-0156", name_cn="强阴离子交换填料", name_en="Source 30Q",
                 sku="17127503", spec="1L", unit="桶", cur_stock=0.4, safe_stock=1,
                 price=9600, cond="4°C", category="层析填料",
                 supplier="Cytiva", maker="Cytiva Sweden AB", country="SE"),
            dict(id="MAT-0088", name_cn="十二烷基硫酸钠", name_en="SDS",
                 sku="—", spec="500g", unit="瓶", cur_stock=3, safe_stock=3,
                 price=86, cond="室温", category="化学试剂",
                 supplier="阿拉丁", maker="Shanghai Aladdin Biochemical Technology Co., Ltd", country="CN"),
            dict(id="MAT-0211", name_cn="凝胶过滤填料", name_en="Sepharose 6 Fast Flow",
                 sku="17-0159-01", spec="1L", unit="桶", cur_stock=2.9, safe_stock=2,
                 price=4950, cond="4°C", category="层析填料",
                 supplier="Cytiva", maker="GE Healthcare Bio-Sciences AB", country="SE"),
            dict(id="MAT-0067", name_cn="氢氧化钠", name_en="NaOH",
                 sku="10019718", spec="500g", unit="瓶", cur_stock=12, safe_stock=5,
                 price=42, cond="室温", category="化学试剂",
                 supplier="国药沪试", maker="Sinopharm Chemical Reagent Co., Ltd", country="CN"),
            dict(id="MAT-0033", name_cn="硫酸铵", name_en="(NH₄)₂SO₄",
                 sku="M105-5KG", spec="5kg", unit="桶", cur_stock=7, safe_stock=3,
                 price=310, cond="室温", category="化学试剂",
                 supplier="VWR", maker="AMRESCO Inc.", country="US"),
            dict(id="MAT-0021", name_cn="无水乙醇", name_en="C₂H₅OH",
                 sku="10009218", spec="500mL", unit="瓶", cur_stock=42, safe_stock=20,
                 price=18, cond="室温", category="化学试剂",
                 supplier="国药沪试", maker="Kunshan Jincheng Reagent Co., Ltd", country="CN"),
            dict(id="MAT-0054", name_cn="乙酸钾", name_en="CH₃COOK",
                 sku="P108325-10KG", spec="10kg", unit="桶", cur_stock=6, safe_stock=3,
                 price=760, cond="室温", category="缓冲液组分",
                 supplier="阿拉丁", maker="Shanghai Aladdin Biochemical Technology Co., Ltd", country="CN"),
            dict(id="MAT-0041", name_cn="冰醋酸", name_en="CH₃COOH",
                 sku="—", spec="10L", unit="桶", cur_stock=22, safe_stock=10,
                 price=168, cond="室温", category="化学试剂",
                 supplier="阿拉丁", maker="Shanghai Aladdin Biochemical Technology Co., Ltd", country="CN"),
            dict(id="MAT-0112", name_cn="三(羟甲基)氨基甲烷盐酸盐", name_en="Tris-HCl",
                 sku="T105287-500G", spec="500g", unit="瓶", cur_stock=8, safe_stock=4,
                 price=196, cond="室温", category="缓冲液组分",
                 supplier="阿拉丁", maker="Shanghai Aladdin Biochemical Technology Co., Ltd", country="CN"),
            dict(id="MAT-0028", name_cn="氯化钠", name_en="NaCl",
                 sku="V900058-500G", spec="500g", unit="瓶", cur_stock=17, safe_stock=5,
                 price=72, cond="室温", category="缓冲液组分",
                 supplier="SIGMA", maker="SIGMA-ALDRICH CHEMIE GmbH", country="DE"),
            dict(id="MAT-0098", name_cn="葡萄糖", name_en="D-(+)-Glucose",
                 sku="V900392-500G", spec="500g", unit="瓶", cur_stock=18, safe_stock=10,
                 price=128, cond="室温", category="缓冲液组分",
                 supplier="SIGMA", maker="SIGMA-ALDRICH CHEMIE GmbH", country="DE"),
            dict(id="MAT-0008", name_cn="注射用水", name_en="WFI",
                 sku="—", spec="1L", unit="瓶", cur_stock=120, safe_stock=50,
                 price=6, cond="室温", category="辅料",
                 supplier="自制", maker="—", country="CN"),
        ]

        for d in materials_data:
            db.add(Material(**d))
        db.flush()

        # ── batches ───────────────────────────────────────────────────────
        batches_data = [
            # MAT-0472 Capto Q Impress
            Batch(material_id="MAT-0472", lot_no="10312662",
                  mfg_date=date(2023, 6, 5),  exp_date=date(2026, 6, 5),  qty=1),
            Batch(material_id="MAT-0472", lot_no="10298441",
                  mfg_date=date(2024, 2, 11), exp_date=date(2027, 2, 11), qty=1),
            # MAT-0015 EDTA-Na₂
            Batch(material_id="MAT-0015", lot_no="20210220",
                  mfg_date=date(2021, 2, 20), exp_date=date(2026, 5, 26), qty=1),
            # MAT-0318 PlasmidSelect Xtra
            Batch(material_id="MAT-0318", lot_no="10309601",
                  mfg_date=date(2022, 4, 10), exp_date=date(2026, 7, 20), qty=1.8),
            # MAT-0156 Source 30Q
            Batch(material_id="MAT-0156", lot_no="10299591",
                  mfg_date=date(2023, 10, 15), exp_date=date(2026, 10, 15), qty=0.4),
            # MAT-0088 SDS
            Batch(material_id="MAT-0088", lot_no="J20210819",
                  mfg_date=date(2021, 8, 19), exp_date=date(2026, 9, 3),  qty=3),
            # MAT-0211 Sepharose 6 FF
            Batch(material_id="MAT-0211", lot_no="10294483",
                  mfg_date=date(2023, 5, 1),  exp_date=date(2026, 11, 13), qty=2.9),
            # MAT-0067 NaOH
            Batch(material_id="MAT-0067", lot_no="20210730",
                  mfg_date=date(2021, 7, 30), exp_date=date(2026, 12, 30), qty=12),
            # MAT-0033 (NH₄)₂SO₄
            Batch(material_id="MAT-0033", lot_no="20A2856964",
                  mfg_date=date(2020, 6, 1),  exp_date=date(2026, 11, 28), qty=7),
            # MAT-0021 Ethanol
            Batch(material_id="MAT-0021", lot_no="20241107",
                  mfg_date=date(2024, 11, 7), exp_date=date(2026, 11, 19), qty=42),
            # MAT-0054 CH₃COOK
            Batch(material_id="MAT-0054", lot_no="A2207914",
                  mfg_date=date(2022, 7, 1),  exp_date=date(2027, 2, 26), qty=6),
            # MAT-0041 CH₃COOH
            Batch(material_id="MAT-0041", lot_no="B2208008",
                  mfg_date=date(2022, 8, 1),  exp_date=date(2027, 3, 10), qty=22),
            # MAT-0112 Tris-HCl
            Batch(material_id="MAT-0112", lot_no="F2103365",
                  mfg_date=date(2021, 3, 1),  exp_date=date(2027, 7, 1),  qty=8),
            # MAT-0028 NaCl
            Batch(material_id="MAT-0028", lot_no="WXBD5382V",
                  mfg_date=date(2022, 11, 1), exp_date=date(2027, 11, 18), qty=17),
            # MAT-0098 Glucose
            Batch(material_id="MAT-0098", lot_no="WXBD3663V",
                  mfg_date=date(2022, 10, 1), exp_date=date(2027, 10, 25), qty=18),
        ]
        db.add_all(batches_data)

        # ── sample transactions ───────────────────────────────────────────
        sample_txs = [
            Transaction(material_id="MAT-0472", tx_type="in",  qty=2,  tx_date=date(2024, 3, 10),
                        lot_no="10312662", operator="admin", note="采购入库"),
            Transaction(material_id="MAT-0015", tx_type="in",  qty=3,  tx_date=date(2024, 1, 15),
                        lot_no="20210220", operator="op01",  note="期初库存"),
            Transaction(material_id="MAT-0015", tx_type="out", qty=2,  tx_date=date(2024, 6, 1),
                        lot_no="20210220", operator="op01",  note="工艺领用"),
            Transaction(material_id="MAT-0318", tx_type="in",  qty=3,  tx_date=date(2024, 4, 10),
                        lot_no="10309601", operator="manager", note="采购入库"),
            Transaction(material_id="MAT-0318", tx_type="out", qty=1.2, tx_date=date(2024, 9, 5),
                        lot_no="10309601", operator="op01",  note="色谱纯化领用"),
            Transaction(material_id="MAT-0021", tx_type="in",  qty=60, tx_date=date(2024, 11, 7),
                        lot_no="20241107", operator="op01",  note="季度补货"),
            Transaction(material_id="MAT-0021", tx_type="out", qty=18, tx_date=date(2025, 1, 20),
                        lot_no="20241107", operator="op01",  note="工艺领用"),
        ]
        db.add_all(sample_txs)

        db.commit()
        print(f"Seeded {len(materials_data)} materials, {len(batches_data)} batches, {len(sample_txs)} transactions.")
    finally:
        db.close()


if __name__ == "__main__":
    run()
