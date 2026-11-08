export type LeagueMarket = {
  id: string;
  league_id: string;
  market_id: string;
  question: string;
  event_title: string | null;
  end_date: string | null;
  outcomes: string[];
  prices: number[];
  resolved: boolean;
  winning_outcome: string | null;
};

export type Prediction = {
  id: string;
  league_id: string;
  league_market_id: string;
  user_id: string;
  pick: string;
  price_at_pick: number;
  points: number | null;
};

export type League = {
  id: string;
  name: string;
  topic: string;
  owner_id: string;
  invite_code: string;
  created_at: string;
  draft_enabled: boolean;
  draft_closes_at: string | null;
  roster_size: number;
};

export type Profile = { id: string; username: string };

/** A draftable person/team. Their results come from the events attached to them. */
export type DraftPlayer = {
  id: string;
  league_id: string;
  name: string;
};

export type DraftEvent = {
  id: string;
  league_id: string;
  player_id: string;
  market_id: string;
  question: string;
  end_date: string | null;
  price: number;
  resolved: boolean;
  won: boolean | null;
};

export type DraftPick = {
  id: string;
  league_id: string;
  player_id: string;
  user_id: string;
};
