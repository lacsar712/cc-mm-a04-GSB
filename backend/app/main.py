from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings
from sqlalchemy import DateTime, Float, ForeignKey, String, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from app.rules import classify


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg2://app:app@localhost:54391/methane"
    jwt_secret: str = "mine-methane-dev-secret"


settings = Settings()
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")
security = HTTPBearer(auto_error=False)
USERS = {
    "gasman": {"role": "writer", "password_hash": pwd.hash("gas123456")},
    "viewer": {"role": "reader", "password_hash": pwd.hash("view123456")},
}

engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine)


class Base(DeclarativeBase):
    pass


class Reading(Base):
    __tablename__ = "readings"
    id: Mapped[int] = mapped_column(primary_key=True)
    site: Mapped[str] = mapped_column(String(80), index=True)
    ch4_pct: Mapped[float] = mapped_column(Float)
    level: Mapped[str] = mapped_column(String(20))
    note: Mapped[str] = mapped_column(String(200))
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Peak(Base):
    """峰值册：每个测点在本班次一行，只由系统按现存班测重算，禁止手工修改。"""

    __tablename__ = "peaks"
    site: Mapped[str] = mapped_column(String(80), primary_key=True)
    ch4_pct: Mapped[float] = mapped_column(Float)
    reading_id: Mapped[int] = mapped_column(ForeignKey("readings.id"))


class LoginIn(BaseModel):
    username: str
    password: str


class ReadingIn(BaseModel):
    site: str = Field(min_length=1, max_length=80)
    ch4_pct: float


class ReadingPatchIn(BaseModel):
    ch4_pct: float


def current_user(credentials: HTTPAuthorizationCredentials | None = Depends(security)) -> dict:
    if credentials is None:
        raise HTTPException(status_code=401, detail="未登录")
    try:
        payload = jwt.decode(credentials.credentials, settings.jwt_secret, algorithms=["HS256"])
    except JWTError as exc:
        raise HTTPException(status_code=401, detail="无效令牌") from exc
    username = payload.get("sub")
    if username not in USERS:
        raise HTTPException(status_code=401, detail="无效令牌")
    return {"username": username, "role": payload.get("role")}


def require_writer(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "writer":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="仅瓦斯检查员可操作")
    return user


sockets: set[WebSocket] = set()
app = FastAPI(title="矿井瓦斯班测台")


def recompute_peak(db: Session, site: str) -> Peak | None:
    """按该测点现存全部班测重算峰值（最高浓度；并列取最早一条主键）。

    新建上报时现存最大值只会升不会降，天然满足“峰值只升不降、低值仍入总表”；
    改正历史浓度时则必须经此函数整体重算，峰值可能回落。
    """
    top = (
        db.query(Reading)
        .filter(Reading.site == site)
        .order_by(Reading.ch4_pct.desc(), Reading.id.asc())
        .first()
    )
    peak = db.get(Peak, site)
    if top is None:
        if peak is not None:
            db.delete(peak)
        return None
    if peak is None:
        peak = Peak(site=site)
        db.add(peak)
    peak.ch4_pct = top.ch4_pct
    peak.reading_id = top.id
    return peak


def peak_payload(peak: Peak) -> dict:
    return {"site": peak.site, "ch4_pct": peak.ch4_pct, "reading_id": peak.reading_id}


@app.on_event("startup")
def startup():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        if db.query(Reading).count() == 0:
            now = datetime.now(timezone.utc)
            for site, ch4 in (("东翼-12", 0.35), ("回风巷", 1.4)):
                level, note = classify(ch4)
                db.add(
                    Reading(
                        site=site,
                        ch4_pct=ch4,
                        level=level,
                        note=note,
                        created_by="gasman",
                        created_at=now,
                    )
                )
            db.commit()
        for (site,) in db.query(Reading.site).distinct().all():
            recompute_peak(db, site)
        db.commit()
    finally:
        db.close()


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "mine-methane-shift"}


@app.post("/api/auth/login")
def login(body: LoginIn):
    user = USERS.get(body.username.strip())
    if not user or not pwd.verify(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode(
        {"sub": body.username.strip(), "role": user["role"], "exp": exp},
        settings.jwt_secret,
        algorithm="HS256",
    )
    return {"access_token": token, "username": body.username.strip(), "role": user["role"]}


@app.get("/api/readings")
def list_readings(_user: dict = Depends(current_user)):
    db = SessionLocal()
    try:
        rows = db.query(Reading).order_by(Reading.id.desc()).all()
        return [
            {
                "id": r.id,
                "site": r.site,
                "ch4_pct": r.ch4_pct,
                "level": r.level,
                "note": r.note,
                "created_by": r.created_by,
            }
            for r in rows
        ]
    finally:
        db.close()


@app.post("/api/readings", status_code=201)
async def create_reading(body: ReadingIn, user: dict = Depends(require_writer)):
    level, note = classify(body.ch4_pct)
    db = SessionLocal()
    try:
        row = Reading(
            site=body.site.strip(),
            ch4_pct=body.ch4_pct,
            level=level,
            note=note,
            created_by=user["username"],
            created_at=datetime.now(timezone.utc),
        )
        db.add(row)
        db.flush()
        peak = recompute_peak(db, row.site)
        db.commit()
        db.refresh(row)
        payload = {
            "kind": "reading",
            "id": row.id,
            "site": row.site,
            "ch4_pct": row.ch4_pct,
            "level": row.level,
            "note": row.note,
        }
        peak_event = {"kind": "peak", **peak_payload(peak)}
    finally:
        db.close()
    await broadcast(payload)
    await broadcast(peak_event)
    return payload


@app.patch("/api/readings/{reading_id}")
async def correct_reading(reading_id: int, body: ReadingPatchIn, user: dict = Depends(require_writer)):
    """改正某条历史浓度；峰值册随即按该测点现存全部行重算，不接受手工改峰值。"""
    db = SessionLocal()
    try:
        row = db.get(Reading, reading_id)
        if row is None:
            raise HTTPException(status_code=404, detail="班测记录不存在")
        row.ch4_pct = body.ch4_pct
        row.level, row.note = classify(body.ch4_pct)
        peak = recompute_peak(db, row.site)
        db.commit()
        db.refresh(row)
        payload = {
            "kind": "reading",
            "id": row.id,
            "site": row.site,
            "ch4_pct": row.ch4_pct,
            "level": row.level,
            "note": row.note,
        }
        peak_event = {"kind": "peak", **peak_payload(peak)}
    finally:
        db.close()
    await broadcast(payload)
    await broadcast(peak_event)
    return payload


@app.get("/api/peaks")
def list_peaks(_user: dict = Depends(current_user)):
    """峰值册：检查员与旁观账号均可读，旁观账号只读、无任何写入途径。"""
    db = SessionLocal()
    try:
        rows = db.query(Peak).order_by(Peak.site.asc()).all()
        return [peak_payload(p) for p in rows]
    finally:
        db.close()


async def broadcast(payload: dict) -> None:
    dead = []
    for ws in list(sockets):
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        sockets.discard(ws)


@app.websocket("/ws/alerts")
async def alerts(ws: WebSocket):
    await ws.accept()
    sockets.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        sockets.discard(ws)
