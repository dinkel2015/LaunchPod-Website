-- Brand and last4 so the dashboard can show which card is on file
-- without another round trip to Square. Non-sensitive: Square returns
-- both alongside the card-on-file token, and neither can be used to
-- charge anything on its own.
alter table public.subscriptions
  add column square_card_brand text,
  add column square_card_last4 text;

comment on column public.subscriptions.square_card_last4 is
  'Display only. The last four digits Square returns with the card-on-file token; not sufficient to charge.';
