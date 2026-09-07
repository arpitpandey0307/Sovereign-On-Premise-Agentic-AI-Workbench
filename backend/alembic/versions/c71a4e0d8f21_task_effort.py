"""task effort: how much thinking a request was asked to be given

Revision ID: c71a4e0d8f21
Revises: b0569b843481
Create Date: 2026-09-07

The operator states an effort on each request and the router biases towards a
smaller or a larger model accordingly. Existing rows take "balanced", which is
the neutral setting and what they were effectively run at.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c71a4e0d8f21'
down_revision: Union[str, Sequence[str], None] = 'b0569b843481'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'tasks',
        sa.Column(
            'effort',
            sa.String(length=16),
            nullable=False,
            server_default='balanced',
        ),
    )


def downgrade() -> None:
    op.drop_column('tasks', 'effort')
