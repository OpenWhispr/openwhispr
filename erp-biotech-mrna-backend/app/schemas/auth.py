from pydantic import BaseModel


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int   # seconds


class UserRead(BaseModel):
    id: int
    username: str
    full_name: str
    role: str
    is_active: bool
