from pydantic import BaseModel
from typing import List


class Image(BaseModel):
    id: str
    tags: List[str]
    # Define image representation in API

# Add LiteSQL model for image representation in the database