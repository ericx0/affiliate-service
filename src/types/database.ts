export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  affiliate: {
    Tables: {
      agent_tiers: {
        Row: {
          display_name: string
          max_kol_count: number | null
          min_kol_count: number
          rate: number
          tier: string
        }
        Insert: {
          display_name: string
          max_kol_count?: number | null
          min_kol_count: number
          rate: number
          tier: string
        }
        Update: {
          display_name?: string
          max_kol_count?: number | null
          min_kol_count?: number
          rate?: number
          tier?: string
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          action: string
          actor_email: string
          actor_id: string
          after_state: Json | null
          before_state: Json | null
          created_at: string | null
          id: string
          reason: string | null
          target_id: string
          target_type: string
        }
        Insert: {
          action: string
          actor_email: string
          actor_id: string
          after_state?: Json | null
          before_state?: Json | null
          created_at?: string | null
          id?: string
          reason?: string | null
          target_id: string
          target_type: string
        }
        Update: {
          action?: string
          actor_email?: string
          actor_id?: string
          after_state?: Json | null
          before_state?: Json | null
          created_at?: string | null
          id?: string
          reason?: string | null
          target_id?: string
          target_type?: string
        }
        Relationships: []
      }
      commissions: {
        Row: {
          approved_at: string | null
          commission_amount: number
          commission_rate: number
          commission_type: string
          cool_down_until: string | null
          created_at: string | null
          cumulative_refunded_amount: number
          currency: string
          id: string
          month_key: string | null
          order_amount: number
          order_id: string
          order_paid_at: string | null
          paid_at: string | null
          promoter_id: string
          refund_reason: string | null
          refunded_at: string | null
          service_completed_at: string | null
          status: string
          stripe_payout_date: string | null
          stripe_transfer_id: string | null
          subscription_id: string | null
          updated_at: string | null
        }
        Insert: {
          approved_at?: string | null
          commission_amount: number
          commission_rate: number
          commission_type: string
          cool_down_until?: string | null
          created_at?: string | null
          cumulative_refunded_amount?: number
          currency?: string
          id?: string
          month_key?: string | null
          order_amount: number
          order_id: string
          order_paid_at?: string | null
          paid_at?: string | null
          promoter_id: string
          refund_reason?: string | null
          refunded_at?: string | null
          service_completed_at?: string | null
          status?: string
          stripe_payout_date?: string | null
          stripe_transfer_id?: string | null
          subscription_id?: string | null
          updated_at?: string | null
        }
        Update: {
          approved_at?: string | null
          commission_amount?: number
          commission_rate?: number
          commission_type?: string
          cool_down_until?: string | null
          created_at?: string | null
          cumulative_refunded_amount?: number
          currency?: string
          id?: string
          month_key?: string | null
          order_amount?: number
          order_id?: string
          order_paid_at?: string | null
          paid_at?: string | null
          promoter_id?: string
          refund_reason?: string | null
          refunded_at?: string | null
          service_completed_at?: string | null
          status?: string
          stripe_payout_date?: string | null
          stripe_transfer_id?: string | null
          subscription_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "commissions_promoter_id_fkey"
            columns: ["promoter_id"]
            isOneToOne: false
            referencedRelation: "promoters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commissions_promoter_id_fkey"
            columns: ["promoter_id"]
            isOneToOne: false
            referencedRelation: "v_promoter_stats"
            referencedColumns: ["id"]
          },
        ]
      }
      failed_events: {
        Row: {
          created_at: string | null
          error_message: string | null
          event_type: string
          id: string
          next_retry_at: string | null
          payload: Json
          resolved_at: string | null
          retry_count: number | null
          status: string | null
        }
        Insert: {
          created_at?: string | null
          error_message?: string | null
          event_type: string
          id?: string
          next_retry_at?: string | null
          payload: Json
          resolved_at?: string | null
          retry_count?: number | null
          status?: string | null
        }
        Update: {
          created_at?: string | null
          error_message?: string | null
          event_type?: string
          id?: string
          next_retry_at?: string | null
          payload?: Json
          resolved_at?: string | null
          retry_count?: number | null
          status?: string | null
        }
        Relationships: []
      }
      fraud_flags: {
        Row: {
          commission_id: string | null
          created_at: string
          details: Json
          flag_type: string
          id: string
          order_id: string | null
          promoter_id: string
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
          updated_at: string
        }
        Insert: {
          commission_id?: string | null
          created_at?: string
          details?: Json
          flag_type: string
          id?: string
          order_id?: string | null
          promoter_id: string
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          commission_id?: string | null
          created_at?: string
          details?: Json
          flag_type?: string
          id?: string
          order_id?: string | null
          promoter_id?: string
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fraud_flags_commission_id_fkey"
            columns: ["commission_id"]
            isOneToOne: false
            referencedRelation: "commissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fraud_flags_commission_id_fkey"
            columns: ["commission_id"]
            isOneToOne: false
            referencedRelation: "v_commission_timeline"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fraud_flags_promoter_id_fkey"
            columns: ["promoter_id"]
            isOneToOne: false
            referencedRelation: "promoters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fraud_flags_promoter_id_fkey"
            columns: ["promoter_id"]
            isOneToOne: false
            referencedRelation: "v_promoter_stats"
            referencedColumns: ["id"]
          },
        ]
      }
      promoters: {
        Row: {
          agent_invite_code: string | null
          agent_level: string | null
          audience_country_codes: string[] | null
          auth_user_id: string | null
          avatar_url: string | null
          bio: string | null
          brand_name: string | null
          commission_rate: number
          commission_type: string
          country_code: string | null
          created_at: string | null
          email: string
          id: string
          name: string
          override_at: string | null
          override_by: string | null
          override_reason: string | null
          phone: string | null
          primary_platform: string | null
          primary_platform_url: string | null
          recruited_by_agent_id: string | null
          role: string
          status: string
          stripe_account_id: string | null
          stripe_onboarding_completed: boolean | null
          suspended_at: string | null
          suspended_reason: string | null
          tax_form_submitted_at: string | null
          tax_form_type: string | null
          total_commission_earned: number | null
          total_commission_paid: number | null
          total_referrals: number | null
          updated_at: string | null
        }
        Insert: {
          agent_invite_code?: string | null
          agent_level?: string | null
          audience_country_codes?: string[] | null
          auth_user_id?: string | null
          avatar_url?: string | null
          bio?: string | null
          brand_name?: string | null
          commission_rate?: number
          commission_type?: string
          country_code?: string | null
          created_at?: string | null
          email: string
          id?: string
          name: string
          override_at?: string | null
          override_by?: string | null
          override_reason?: string | null
          phone?: string | null
          primary_platform?: string | null
          primary_platform_url?: string | null
          recruited_by_agent_id?: string | null
          role?: string
          status?: string
          stripe_account_id?: string | null
          stripe_onboarding_completed?: boolean | null
          suspended_at?: string | null
          suspended_reason?: string | null
          tax_form_submitted_at?: string | null
          tax_form_type?: string | null
          total_commission_earned?: number | null
          total_commission_paid?: number | null
          total_referrals?: number | null
          updated_at?: string | null
        }
        Update: {
          agent_invite_code?: string | null
          agent_level?: string | null
          audience_country_codes?: string[] | null
          auth_user_id?: string | null
          avatar_url?: string | null
          bio?: string | null
          brand_name?: string | null
          commission_rate?: number
          commission_type?: string
          country_code?: string | null
          created_at?: string | null
          email?: string
          id?: string
          name?: string
          override_at?: string | null
          override_by?: string | null
          override_reason?: string | null
          phone?: string | null
          primary_platform?: string | null
          primary_platform_url?: string | null
          recruited_by_agent_id?: string | null
          role?: string
          status?: string
          stripe_account_id?: string | null
          stripe_onboarding_completed?: boolean | null
          suspended_at?: string | null
          suspended_reason?: string | null
          tax_form_submitted_at?: string | null
          tax_form_type?: string | null
          total_commission_earned?: number | null
          total_commission_paid?: number | null
          total_referrals?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "promoters_recruited_by_agent_id_fkey"
            columns: ["recruited_by_agent_id"]
            isOneToOne: false
            referencedRelation: "promoters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promoters_recruited_by_agent_id_fkey"
            columns: ["recruited_by_agent_id"]
            isOneToOne: false
            referencedRelation: "v_promoter_stats"
            referencedColumns: ["id"]
          },
        ]
      }
      referral_clicks: {
        Row: {
          attribution_window_ends_at: string | null
          clicked_at: string | null
          converted_at: string | null
          converted_order_id: string | null
          converted_user_id: string | null
          country: string | null
          id: string
          ip_address: unknown
          promoter_id: string
          referral_code: string
          user_agent: string | null
          visitor_session_id: string
        }
        Insert: {
          attribution_window_ends_at?: string | null
          clicked_at?: string | null
          converted_at?: string | null
          converted_order_id?: string | null
          converted_user_id?: string | null
          country?: string | null
          id?: string
          ip_address?: unknown
          promoter_id: string
          referral_code: string
          user_agent?: string | null
          visitor_session_id: string
        }
        Update: {
          attribution_window_ends_at?: string | null
          clicked_at?: string | null
          converted_at?: string | null
          converted_order_id?: string | null
          converted_user_id?: string | null
          country?: string | null
          id?: string
          ip_address?: unknown
          promoter_id?: string
          referral_code?: string
          user_agent?: string | null
          visitor_session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "referral_clicks_promoter_id_fkey"
            columns: ["promoter_id"]
            isOneToOne: false
            referencedRelation: "promoters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_clicks_promoter_id_fkey"
            columns: ["promoter_id"]
            isOneToOne: false
            referencedRelation: "v_promoter_stats"
            referencedColumns: ["id"]
          },
        ]
      }
      referral_codes: {
        Row: {
          code: string
          created_at: string | null
          custom_landing_enabled: boolean | null
          custom_landing_slug: string | null
          expires_at: string | null
          id: string
          is_active: boolean | null
          promoter_id: string
          type: string
        }
        Insert: {
          code: string
          created_at?: string | null
          custom_landing_enabled?: boolean | null
          custom_landing_slug?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean | null
          promoter_id: string
          type?: string
        }
        Update: {
          code?: string
          created_at?: string | null
          custom_landing_enabled?: boolean | null
          custom_landing_slug?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean | null
          promoter_id?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "referral_codes_promoter_id_fkey"
            columns: ["promoter_id"]
            isOneToOne: false
            referencedRelation: "promoters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_codes_promoter_id_fkey"
            columns: ["promoter_id"]
            isOneToOne: false
            referencedRelation: "v_promoter_stats"
            referencedColumns: ["id"]
          },
        ]
      }
      refund_events: {
        Row: {
          created_at: string
          event_id: string
          id: number
          order_id: string
          processed_at: string
          reason: string | null
          refund_amount: number | null
        }
        Insert: {
          created_at?: string
          event_id: string
          id?: number
          order_id: string
          processed_at?: string
          reason?: string | null
          refund_amount?: number | null
        }
        Update: {
          created_at?: string
          event_id?: string
          id?: number
          order_id?: string
          processed_at?: string
          reason?: string | null
          refund_amount?: number | null
        }
        Relationships: []
      }
      tax_forms: {
        Row: {
          created_at: string
          file_path: string
          form_type: string
          id: string
          promoter_id: string
          signer_name: string
          status: string
          submitted_at: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          file_path: string
          form_type: string
          id?: string
          promoter_id: string
          signer_name: string
          status?: string
          submitted_at?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          file_path?: string
          form_type?: string
          id?: string
          promoter_id?: string
          signer_name?: string
          status?: string
          submitted_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tax_forms_promoter_id_fkey"
            columns: ["promoter_id"]
            isOneToOne: true
            referencedRelation: "promoters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_forms_promoter_id_fkey"
            columns: ["promoter_id"]
            isOneToOne: true
            referencedRelation: "v_promoter_stats"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      v_commission_timeline: {
        Row: {
          approved_at: string | null
          commission_amount: number | null
          commission_rate: number | null
          commission_type: string | null
          cool_down_until: string | null
          currency: string | null
          customer_email: string | null
          id: string | null
          month_key: string | null
          order_amount: number | null
          order_id: string | null
          order_no: string | null
          order_paid_at: string | null
          paid_at: string | null
          promoter_email: string | null
          promoter_id: string | null
          promoter_name: string | null
          refund_reason: string | null
          refunded_at: string | null
          service_completed_at: string | null
          status: string | null
          stripe_transfer_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "commissions_promoter_id_fkey"
            columns: ["promoter_id"]
            isOneToOne: false
            referencedRelation: "promoters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commissions_promoter_id_fkey"
            columns: ["promoter_id"]
            isOneToOne: false
            referencedRelation: "v_promoter_stats"
            referencedColumns: ["id"]
          },
        ]
      }
      v_promoter_stats: {
        Row: {
          active_codes: number | null
          brand_name: string | null
          commission_rate: number | null
          commission_type: string | null
          country_code: string | null
          created_at: string | null
          email: string | null
          id: string | null
          last_commission_at: string | null
          name: string | null
          primary_platform: string | null
          status: string | null
          stripe_onboarding_completed: boolean | null
          total_approved: number | null
          total_clicks: number | null
          total_commissions: number | null
          total_paid: number | null
          total_pending: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      compute_agent_tier: {
        Args: { p_agent_id: string }
        Returns: {
          rate: number
          tier: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  documents: {
    Tables: {
      signings: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          invite_token: string
          invited_at: string
          invited_by_email: string | null
          notes: string | null
          promoter_id: string | null
          signature_text: string | null
          signed_at: string | null
          signed_content_hash: string | null
          signed_ip: unknown
          signed_ua: string | null
          signer_email: string
          signer_name: string | null
          signer_type: string
          status: string
          template_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          id?: string
          invite_token?: string
          invited_at?: string
          invited_by_email?: string | null
          notes?: string | null
          promoter_id?: string | null
          signature_text?: string | null
          signed_at?: string | null
          signed_content_hash?: string | null
          signed_ip?: unknown
          signed_ua?: string | null
          signer_email: string
          signer_name?: string | null
          signer_type?: string
          status?: string
          template_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          invite_token?: string
          invited_at?: string
          invited_by_email?: string | null
          notes?: string | null
          promoter_id?: string | null
          signature_text?: string | null
          signed_at?: string | null
          signed_content_hash?: string | null
          signed_ip?: unknown
          signed_ua?: string | null
          signer_email?: string
          signer_name?: string | null
          signer_type?: string
          status?: string
          template_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "signings_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "templates"
            referencedColumns: ["id"]
          },
        ]
      }
      templates: {
        Row: {
          applicable_to: string[]
          content_hash: string
          content_md: string
          created_at: string
          created_by_email: string | null
          id: string
          is_active: boolean
          name: string
          type: string
          version: string
        }
        Insert: {
          applicable_to?: string[]
          content_hash: string
          content_md: string
          created_at?: string
          created_by_email?: string | null
          id?: string
          is_active?: boolean
          name: string
          type: string
          version: string
        }
        Update: {
          applicable_to?: string[]
          content_hash?: string
          content_md?: string
          created_at?: string
          created_by_email?: string | null
          id?: string
          is_active?: boolean
          name?: string
          type?: string
          version?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      _old_checkups: {
        Row: {
          created_at: string | null
          description: string | null
          features: string[] | null
          hospital_id: string | null
          id: string
          is_active: boolean | null
          is_popular: boolean | null
          name: string
          name_cn: string | null
          price: number | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          features?: string[] | null
          hospital_id?: string | null
          id: string
          is_active?: boolean | null
          is_popular?: boolean | null
          name: string
          name_cn?: string | null
          price?: number | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          features?: string[] | null
          hospital_id?: string | null
          id?: string
          is_active?: boolean | null
          is_popular?: boolean | null
          name?: string
          name_cn?: string | null
          price?: number | null
        }
        Relationships: []
      }
      account_deletion_requests: {
        Row: {
          cancelled_at: string | null
          created_at: string
          id: string
          idempotency_key: string | null
          purged_at: string | null
          request_ip: unknown
          request_user_agent: string | null
          requested_at: string
          scheduled_purge_at: string
          status: string
          user_id: string
        }
        Insert: {
          cancelled_at?: string | null
          created_at?: string
          id?: string
          idempotency_key?: string | null
          purged_at?: string | null
          request_ip?: unknown
          request_user_agent?: string | null
          requested_at?: string
          scheduled_purge_at?: string
          status?: string
          user_id: string
        }
        Update: {
          cancelled_at?: string | null
          created_at?: string
          id?: string
          idempotency_key?: string | null
          purged_at?: string | null
          request_ip?: unknown
          request_user_agent?: string | null
          requested_at?: string
          scheduled_purge_at?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      admin_audit_logs: {
        Row: {
          action: string
          actor_email: string
          actor_id: string
          actor_role: string
          after_state: Json | null
          before_state: Json | null
          created_at: string
          id: string
          ip_address: unknown
          reason: string | null
          target_id: string | null
          target_type: string
          user_agent: string | null
        }
        Insert: {
          action: string
          actor_email: string
          actor_id: string
          actor_role: string
          after_state?: Json | null
          before_state?: Json | null
          created_at?: string
          id?: string
          ip_address?: unknown
          reason?: string | null
          target_id?: string | null
          target_type: string
          user_agent?: string | null
        }
        Update: {
          action?: string
          actor_email?: string
          actor_id?: string
          actor_role?: string
          after_state?: Json | null
          before_state?: Json | null
          created_at?: string
          id?: string
          ip_address?: unknown
          reason?: string | null
          target_id?: string | null
          target_type?: string
          user_agent?: string | null
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: string
          actor_email: string | null
          actor_id: string | null
          created_at: string | null
          id: string
          ip_address: unknown
          new_data: Json | null
          old_data: Json | null
          record_id: string | null
          table_name: string
          user_agent: string | null
        }
        Insert: {
          action: string
          actor_email?: string | null
          actor_id?: string | null
          created_at?: string | null
          id?: string
          ip_address?: unknown
          new_data?: Json | null
          old_data?: Json | null
          record_id?: string | null
          table_name: string
          user_agent?: string | null
        }
        Update: {
          action?: string
          actor_email?: string | null
          actor_id?: string | null
          created_at?: string | null
          id?: string
          ip_address?: unknown
          new_data?: Json | null
          old_data?: Json | null
          record_id?: string | null
          table_name?: string
          user_agent?: string | null
        }
        Relationships: []
      }
      chat_conversations: {
        Row: {
          created_at: string | null
          escort_id: string | null
          id: string
          status: string | null
          title: string | null
          type: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          escort_id?: string | null
          id?: string
          status?: string | null
          title?: string | null
          type?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          escort_id?: string | null
          id?: string
          status?: string | null
          title?: string | null
          type?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_conversations_escort_id_fkey"
            columns: ["escort_id"]
            isOneToOne: false
            referencedRelation: "escorts"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_messages: {
        Row: {
          content: string
          conversation_id: string | null
          created_at: string | null
          id: string
          is_read: boolean | null
          sender_id: string
          sender_type: string | null
          wecom_msg_id: string | null
        }
        Insert: {
          content: string
          conversation_id?: string | null
          created_at?: string | null
          id?: string
          is_read?: boolean | null
          sender_id: string
          sender_type?: string | null
          wecom_msg_id?: string | null
        }
        Update: {
          content?: string
          conversation_id?: string | null
          created_at?: string | null
          id?: string
          is_read?: boolean | null
          sender_id?: string
          sender_type?: string | null
          wecom_msg_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "chat_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      checkup_packages: {
        Row: {
          booking_fee: number | null
          category: string | null
          created_at: string | null
          currency: string | null
          description: string | null
          description_ar: string | null
          description_cn: string | null
          description_es: string | null
          description_ru: string | null
          duration: string | null
          duration_ar: string | null
          duration_cn: string | null
          duration_es: string | null
          duration_ru: string | null
          features: string[] | null
          features_ar: string[] | null
          features_cn: string[] | null
          features_es: string[] | null
          features_ru: string[] | null
          hospital_id: string | null
          hospital_name_ar: string | null
          hospital_name_es: string | null
          hospital_name_ru: string | null
          id: string
          is_active: boolean | null
          is_popular: boolean | null
          items: Json | null
          name: string
          name_ar: string | null
          name_cn: string
          name_es: string | null
          name_ru: string | null
          original_price: number | null
          preparation_notes: string[] | null
          preparation_notes_ar: string[] | null
          preparation_notes_cn: string[] | null
          preparation_notes_es: string[] | null
          preparation_notes_ru: string[] | null
          price: number
          report_time: string | null
          report_time_ar: string | null
          report_time_cn: string | null
          report_time_es: string | null
          report_time_ru: string | null
          sort_order: number | null
          target_group: string | null
          target_group_ar: string | null
          target_group_cn: string | null
          target_group_es: string | null
          target_group_ru: string | null
          updated_at: string | null
        }
        Insert: {
          booking_fee?: number | null
          category?: string | null
          created_at?: string | null
          currency?: string | null
          description?: string | null
          description_ar?: string | null
          description_cn?: string | null
          description_es?: string | null
          description_ru?: string | null
          duration?: string | null
          duration_ar?: string | null
          duration_cn?: string | null
          duration_es?: string | null
          duration_ru?: string | null
          features?: string[] | null
          features_ar?: string[] | null
          features_cn?: string[] | null
          features_es?: string[] | null
          features_ru?: string[] | null
          hospital_id?: string | null
          hospital_name_ar?: string | null
          hospital_name_es?: string | null
          hospital_name_ru?: string | null
          id?: string
          is_active?: boolean | null
          is_popular?: boolean | null
          items?: Json | null
          name: string
          name_ar?: string | null
          name_cn: string
          name_es?: string | null
          name_ru?: string | null
          original_price?: number | null
          preparation_notes?: string[] | null
          preparation_notes_ar?: string[] | null
          preparation_notes_cn?: string[] | null
          preparation_notes_es?: string[] | null
          preparation_notes_ru?: string[] | null
          price?: number
          report_time?: string | null
          report_time_ar?: string | null
          report_time_cn?: string | null
          report_time_es?: string | null
          report_time_ru?: string | null
          sort_order?: number | null
          target_group?: string | null
          target_group_ar?: string | null
          target_group_cn?: string | null
          target_group_es?: string | null
          target_group_ru?: string | null
          updated_at?: string | null
        }
        Update: {
          booking_fee?: number | null
          category?: string | null
          created_at?: string | null
          currency?: string | null
          description?: string | null
          description_ar?: string | null
          description_cn?: string | null
          description_es?: string | null
          description_ru?: string | null
          duration?: string | null
          duration_ar?: string | null
          duration_cn?: string | null
          duration_es?: string | null
          duration_ru?: string | null
          features?: string[] | null
          features_ar?: string[] | null
          features_cn?: string[] | null
          features_es?: string[] | null
          features_ru?: string[] | null
          hospital_id?: string | null
          hospital_name_ar?: string | null
          hospital_name_es?: string | null
          hospital_name_ru?: string | null
          id?: string
          is_active?: boolean | null
          is_popular?: boolean | null
          items?: Json | null
          name?: string
          name_ar?: string | null
          name_cn?: string
          name_es?: string | null
          name_ru?: string | null
          original_price?: number | null
          preparation_notes?: string[] | null
          preparation_notes_ar?: string[] | null
          preparation_notes_cn?: string[] | null
          preparation_notes_es?: string[] | null
          preparation_notes_ru?: string[] | null
          price?: number
          report_time?: string | null
          report_time_ar?: string | null
          report_time_cn?: string | null
          report_time_es?: string | null
          report_time_ru?: string | null
          sort_order?: number | null
          target_group?: string | null
          target_group_ar?: string | null
          target_group_cn?: string | null
          target_group_es?: string | null
          target_group_ru?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "checkup_packages_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
        ]
      }
      ci_download_logs: {
        Row: {
          case_id: string
          downloaded_at: string | null
          file_path: string | null
          id: string
          ip_address: string | null
          user_agent: string | null
          user_id: string
        }
        Insert: {
          case_id: string
          downloaded_at?: string | null
          file_path?: string | null
          id?: string
          ip_address?: string | null
          user_agent?: string | null
          user_id: string
        }
        Update: {
          case_id?: string
          downloaded_at?: string | null
          file_path?: string | null
          id?: string
          ip_address?: string | null
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ci_download_logs_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "critical_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      ci_email_logs: {
        Row: {
          case_id: string | null
          email_type: string | null
          id: string
          order_id: string | null
          recipient_email: string | null
          resend_message_id: string | null
          sent_at: string | null
          status: string | null
        }
        Insert: {
          case_id?: string | null
          email_type?: string | null
          id?: string
          order_id?: string | null
          recipient_email?: string | null
          resend_message_id?: string | null
          sent_at?: string | null
          status?: string | null
        }
        Update: {
          case_id?: string | null
          email_type?: string | null
          id?: string
          order_id?: string | null
          recipient_email?: string | null
          resend_message_id?: string | null
          sent_at?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ci_email_logs_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "critical_cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ci_email_logs_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "ci_service_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      ci_intakes: {
        Row: {
          condition_notes: string
          consent_version: string
          created_at: string
          id: string
          locale: string
          medical_files: Json
          medical_files_purged_at: string | null
          patient_email: string
          patient_name: string
          patient_nationality: string | null
          patient_phone: string | null
          referral_code: string | null
          stripe_session_created_at: string | null
          stripe_session_id: string | null
          submission_ip: unknown
          submission_user_agent: string | null
          submitted_at: string
          updated_at: string
          user_id: string
          visit_type: string | null
        }
        Insert: {
          condition_notes: string
          consent_version?: string
          created_at?: string
          id?: string
          locale?: string
          medical_files?: Json
          medical_files_purged_at?: string | null
          patient_email: string
          patient_name: string
          patient_nationality?: string | null
          patient_phone?: string | null
          referral_code?: string | null
          stripe_session_created_at?: string | null
          stripe_session_id?: string | null
          submission_ip?: unknown
          submission_user_agent?: string | null
          submitted_at?: string
          updated_at?: string
          user_id: string
          visit_type?: string | null
        }
        Update: {
          condition_notes?: string
          consent_version?: string
          created_at?: string
          id?: string
          locale?: string
          medical_files?: Json
          medical_files_purged_at?: string | null
          patient_email?: string
          patient_name?: string
          patient_nationality?: string | null
          patient_phone?: string | null
          referral_code?: string | null
          stripe_session_created_at?: string | null
          stripe_session_id?: string | null
          submission_ip?: unknown
          submission_user_agent?: string | null
          submitted_at?: string
          updated_at?: string
          user_id?: string
          visit_type?: string | null
        }
        Relationships: []
      }
      ci_messages: {
        Row: {
          case_id: string
          created_at: string | null
          encrypted_content: string
          id: string
          read_at: string | null
          sender_id: string
          sender_role: string
        }
        Insert: {
          case_id: string
          created_at?: string | null
          encrypted_content: string
          id?: string
          read_at?: string | null
          sender_id: string
          sender_role: string
        }
        Update: {
          case_id?: string
          created_at?: string | null
          encrypted_content?: string
          id?: string
          read_at?: string | null
          sender_id?: string
          sender_role?: string
        }
        Relationships: [
          {
            foreignKeyName: "ci_messages_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "critical_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      ci_service_catalog: {
        Row: {
          can_be_online: boolean | null
          category: string
          code: string
          created_at: string | null
          default_sla_days: number | null
          delivery_content_en: string | null
          delivery_content_zh: string | null
          delivery_time_en: string | null
          delivery_time_zh: string | null
          description_ar: string | null
          description_en: string | null
          description_es: string | null
          description_ru: string | null
          description_zh: string | null
          has_visit_type: boolean | null
          id: string
          is_active: boolean | null
          name_ar: string | null
          name_en: string
          name_es: string | null
          name_ru: string | null
          name_zh: string
          pricing_type: string
          sort_order: number | null
          unit_price: number | null
          unit_type: string | null
          unit_type_ar: string | null
          unit_type_en: string | null
          unit_type_es: string | null
          unit_type_ru: string | null
          unit_type_zh: string | null
          updated_at: string | null
        }
        Insert: {
          can_be_online?: boolean | null
          category: string
          code: string
          created_at?: string | null
          default_sla_days?: number | null
          delivery_content_en?: string | null
          delivery_content_zh?: string | null
          delivery_time_en?: string | null
          delivery_time_zh?: string | null
          description_ar?: string | null
          description_en?: string | null
          description_es?: string | null
          description_ru?: string | null
          description_zh?: string | null
          has_visit_type?: boolean | null
          id?: string
          is_active?: boolean | null
          name_ar?: string | null
          name_en: string
          name_es?: string | null
          name_ru?: string | null
          name_zh: string
          pricing_type: string
          sort_order?: number | null
          unit_price?: number | null
          unit_type?: string | null
          unit_type_ar?: string | null
          unit_type_en?: string | null
          unit_type_es?: string | null
          unit_type_ru?: string | null
          unit_type_zh?: string | null
          updated_at?: string | null
        }
        Update: {
          can_be_online?: boolean | null
          category?: string
          code?: string
          created_at?: string | null
          default_sla_days?: number | null
          delivery_content_en?: string | null
          delivery_content_zh?: string | null
          delivery_time_en?: string | null
          delivery_time_zh?: string | null
          description_ar?: string | null
          description_en?: string | null
          description_es?: string | null
          description_ru?: string | null
          description_zh?: string | null
          has_visit_type?: boolean | null
          id?: string
          is_active?: boolean | null
          name_ar?: string | null
          name_en?: string
          name_es?: string | null
          name_ru?: string | null
          name_zh?: string
          pricing_type?: string
          sort_order?: number | null
          unit_price?: number | null
          unit_type?: string | null
          unit_type_ar?: string | null
          unit_type_en?: string | null
          unit_type_es?: string | null
          unit_type_ru?: string | null
          unit_type_zh?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      ci_service_orders: {
        Row: {
          assigned_to: string | null
          cancellation_policy_version: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          case_id: string
          client_ack_ip: string | null
          client_acknowledged_at: string | null
          completion_notes: string | null
          created_at: string | null
          currency: string | null
          id: string
          items: Json
          order_no: string
          paid_at: string | null
          pricing_type: string
          promoter_id: string | null
          quote_expires_at: string | null
          quote_request_notes: string | null
          quoted_amount: number | null
          quoted_at: string | null
          quoted_by: string | null
          service_completed_at: string | null
          service_started_at: string | null
          status: string
          stripe_payment_intent_id: string | null
          stripe_session_id: string | null
          subtotal: number | null
          total_amount: number | null
          updated_at: string | null
          user_id: string
          visit_type: string | null
        }
        Insert: {
          assigned_to?: string | null
          cancellation_policy_version?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          case_id: string
          client_ack_ip?: string | null
          client_acknowledged_at?: string | null
          completion_notes?: string | null
          created_at?: string | null
          currency?: string | null
          id?: string
          items?: Json
          order_no: string
          paid_at?: string | null
          pricing_type: string
          promoter_id?: string | null
          quote_expires_at?: string | null
          quote_request_notes?: string | null
          quoted_amount?: number | null
          quoted_at?: string | null
          quoted_by?: string | null
          service_completed_at?: string | null
          service_started_at?: string | null
          status?: string
          stripe_payment_intent_id?: string | null
          stripe_session_id?: string | null
          subtotal?: number | null
          total_amount?: number | null
          updated_at?: string | null
          user_id: string
          visit_type?: string | null
        }
        Update: {
          assigned_to?: string | null
          cancellation_policy_version?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          case_id?: string
          client_ack_ip?: string | null
          client_acknowledged_at?: string | null
          completion_notes?: string | null
          created_at?: string | null
          currency?: string | null
          id?: string
          items?: Json
          order_no?: string
          paid_at?: string | null
          pricing_type?: string
          promoter_id?: string | null
          quote_expires_at?: string | null
          quote_request_notes?: string | null
          quoted_amount?: number | null
          quoted_at?: string | null
          quoted_by?: string | null
          service_completed_at?: string | null
          service_started_at?: string | null
          status?: string
          stripe_payment_intent_id?: string | null
          stripe_session_id?: string | null
          subtotal?: number | null
          total_amount?: number | null
          updated_at?: string | null
          user_id?: string
          visit_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ci_service_orders_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "critical_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_orders: {
        Row: {
          ai_job_id: string | null
          claim_country: string | null
          created_at: string | null
          document_urls: string[] | null
          error_message: string | null
          id: string
          insurance_provider: string | null
          ocr_raw_text: string | null
          order_id: string | null
          output_language: string | null
          report_json: Json | null
          report_pdf_url: string | null
          status: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          ai_job_id?: string | null
          claim_country?: string | null
          created_at?: string | null
          document_urls?: string[] | null
          error_message?: string | null
          id?: string
          insurance_provider?: string | null
          ocr_raw_text?: string | null
          order_id?: string | null
          output_language?: string | null
          report_json?: Json | null
          report_pdf_url?: string | null
          status?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          ai_job_id?: string | null
          claim_country?: string | null
          created_at?: string | null
          document_urls?: string[] | null
          error_message?: string | null
          id?: string
          insurance_provider?: string | null
          ocr_raw_text?: string | null
          order_id?: string | null
          output_language?: string | null
          report_json?: Json | null
          report_pdf_url?: string | null
          status?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      contact_submissions: {
        Row: {
          created_at: string | null
          email: string
          first_name: string
          honeypot: string | null
          id: string
          last_ip: unknown
          last_name: string
          locale: string | null
          message: string | null
          service: string | null
        }
        Insert: {
          created_at?: string | null
          email: string
          first_name: string
          honeypot?: string | null
          id?: string
          last_ip?: unknown
          last_name: string
          locale?: string | null
          message?: string | null
          service?: string | null
        }
        Update: {
          created_at?: string | null
          email?: string
          first_name?: string
          honeypot?: string | null
          id?: string
          last_ip?: unknown
          last_name?: string
          locale?: string | null
          message?: string | null
          service?: string | null
        }
        Relationships: []
      }
      critical_cases: {
        Row: {
          admin_notes: string | null
          amount: number | null
          assigned_to: string | null
          cancellation_policy_acknowledged_at: string | null
          cancellation_policy_version: string | null
          case_manager_id: string | null
          case_no: string | null
          consent_agreed_at: string | null
          consent_version: string | null
          coordination_notes: string | null
          created_at: string | null
          currency: string | null
          duration_days: number | null
          id: string
          intake_id: string | null
          intended_department: string
          locale: string | null
          medical_files: Json | null
          medical_files_purged_at: string | null
          paid_at: string | null
          patient_email: string
          patient_name: string
          patient_nationality: string | null
          patient_phone: string | null
          phase2_unlocked: boolean | null
          preferred_date: string | null
          preferred_hospital: string | null
          promoter_id: string | null
          referral_code: string | null
          report_ack_ip: string | null
          report_acknowledged_at: string | null
          report_delivered_at: string | null
          report_file_path: string | null
          service_type: string
          status: string | null
          stripe_payment_intent_id: string | null
          stripe_session_id: string | null
          submission_ip: string | null
          submission_user_agent: string | null
          translator_id: string | null
          updated_at: string | null
          user_agreed_reexamination: boolean
          user_agreed_service_only: boolean
          user_id: string | null
        }
        Insert: {
          admin_notes?: string | null
          amount?: number | null
          assigned_to?: string | null
          cancellation_policy_acknowledged_at?: string | null
          cancellation_policy_version?: string | null
          case_manager_id?: string | null
          case_no?: string | null
          consent_agreed_at?: string | null
          consent_version?: string | null
          coordination_notes?: string | null
          created_at?: string | null
          currency?: string | null
          duration_days?: number | null
          id?: string
          intake_id?: string | null
          intended_department?: string
          locale?: string | null
          medical_files?: Json | null
          medical_files_purged_at?: string | null
          paid_at?: string | null
          patient_email: string
          patient_name: string
          patient_nationality?: string | null
          patient_phone?: string | null
          phase2_unlocked?: boolean | null
          preferred_date?: string | null
          preferred_hospital?: string | null
          promoter_id?: string | null
          referral_code?: string | null
          report_ack_ip?: string | null
          report_acknowledged_at?: string | null
          report_delivered_at?: string | null
          report_file_path?: string | null
          service_type?: string
          status?: string | null
          stripe_payment_intent_id?: string | null
          stripe_session_id?: string | null
          submission_ip?: string | null
          submission_user_agent?: string | null
          translator_id?: string | null
          updated_at?: string | null
          user_agreed_reexamination?: boolean
          user_agreed_service_only?: boolean
          user_id?: string | null
        }
        Update: {
          admin_notes?: string | null
          amount?: number | null
          assigned_to?: string | null
          cancellation_policy_acknowledged_at?: string | null
          cancellation_policy_version?: string | null
          case_manager_id?: string | null
          case_no?: string | null
          consent_agreed_at?: string | null
          consent_version?: string | null
          coordination_notes?: string | null
          created_at?: string | null
          currency?: string | null
          duration_days?: number | null
          id?: string
          intake_id?: string | null
          intended_department?: string
          locale?: string | null
          medical_files?: Json | null
          medical_files_purged_at?: string | null
          paid_at?: string | null
          patient_email?: string
          patient_name?: string
          patient_nationality?: string | null
          patient_phone?: string | null
          phase2_unlocked?: boolean | null
          preferred_date?: string | null
          preferred_hospital?: string | null
          promoter_id?: string | null
          referral_code?: string | null
          report_ack_ip?: string | null
          report_acknowledged_at?: string | null
          report_delivered_at?: string | null
          report_file_path?: string | null
          service_type?: string
          status?: string | null
          stripe_payment_intent_id?: string | null
          stripe_session_id?: string | null
          submission_ip?: string | null
          submission_user_agent?: string | null
          translator_id?: string | null
          updated_at?: string | null
          user_agreed_reexamination?: boolean
          user_agreed_service_only?: boolean
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "critical_cases_intake_id_fkey"
            columns: ["intake_id"]
            isOneToOne: false
            referencedRelation: "ci_intakes"
            referencedColumns: ["id"]
          },
        ]
      }
      custom_quotes: {
        Row: {
          consent_agreed_at: string | null
          consent_version: string | null
          created_at: string | null
          description: string | null
          id: string
          line_items: Json
          status: string
          stripe_payment_id: string | null
          submission_ip: string | null
          submission_user_agent: string | null
          title: string
          total_amount_usd: number
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          consent_agreed_at?: string | null
          consent_version?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          line_items?: Json
          status?: string
          stripe_payment_id?: string | null
          submission_ip?: string | null
          submission_user_agent?: string | null
          title: string
          total_amount_usd: number
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          consent_agreed_at?: string | null
          consent_version?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          line_items?: Json
          status?: string
          stripe_payment_id?: string | null
          submission_ip?: string | null
          submission_user_agent?: string | null
          title?: string
          total_amount_usd?: number
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      disputes: {
        Row: {
          amount_cents: number | null
          created_at: string
          currency: string | null
          evidence_due_by: string | null
          id: string
          order_id: string | null
          payment_intent_id: string | null
          raw: Json
          reason: string | null
          status: string | null
          stripe_dispute_id: string
          updated_at: string
        }
        Insert: {
          amount_cents?: number | null
          created_at?: string
          currency?: string | null
          evidence_due_by?: string | null
          id?: string
          order_id?: string | null
          payment_intent_id?: string | null
          raw?: Json
          reason?: string | null
          status?: string | null
          stripe_dispute_id: string
          updated_at?: string
        }
        Update: {
          amount_cents?: number | null
          created_at?: string
          currency?: string | null
          evidence_due_by?: string | null
          id?: string
          order_id?: string | null
          payment_intent_id?: string | null
          raw?: Json
          reason?: string | null
          status?: string | null
          stripe_dispute_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "disputes_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      escort_availability: {
        Row: {
          created_at: string | null
          date: string
          escort_id: string | null
          id: string
          is_available: boolean | null
          unavailability_reason: string | null
        }
        Insert: {
          created_at?: string | null
          date: string
          escort_id?: string | null
          id?: string
          is_available?: boolean | null
          unavailability_reason?: string | null
        }
        Update: {
          created_at?: string | null
          date?: string
          escort_id?: string | null
          id?: string
          is_available?: boolean | null
          unavailability_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "escort_availability_escort_id_fkey"
            columns: ["escort_id"]
            isOneToOne: false
            referencedRelation: "escorts"
            referencedColumns: ["id"]
          },
        ]
      }
      escorts: {
        Row: {
          avatar_url: string | null
          bio: string | null
          created_at: string | null
          email: string | null
          hourly_rate: number | null
          id: string
          internal_notes: string | null
          is_active: boolean | null
          is_verified: boolean | null
          languages: string[] | null
          name: string
          nickname: string | null
          phone: string | null
          rating: number | null
          review_count: number | null
          specialties: string[] | null
          wecom_userid: string | null
          years_of_experience: number | null
        }
        Insert: {
          avatar_url?: string | null
          bio?: string | null
          created_at?: string | null
          email?: string | null
          hourly_rate?: number | null
          id: string
          internal_notes?: string | null
          is_active?: boolean | null
          is_verified?: boolean | null
          languages?: string[] | null
          name: string
          nickname?: string | null
          phone?: string | null
          rating?: number | null
          review_count?: number | null
          specialties?: string[] | null
          wecom_userid?: string | null
          years_of_experience?: number | null
        }
        Update: {
          avatar_url?: string | null
          bio?: string | null
          created_at?: string | null
          email?: string | null
          hourly_rate?: number | null
          id?: string
          internal_notes?: string | null
          is_active?: boolean | null
          is_verified?: boolean | null
          languages?: string[] | null
          name?: string
          nickname?: string | null
          phone?: string | null
          rating?: number | null
          review_count?: number | null
          specialties?: string[] | null
          wecom_userid?: string | null
          years_of_experience?: number | null
        }
        Relationships: []
      }
      guides: {
        Row: {
          author: string | null
          category: string | null
          content_cn: string | null
          content_en: string
          created_at: string | null
          excerpt_cn: string | null
          excerpt_en: string | null
          id: string
          image_url: string | null
          slug: string
          title_cn: string | null
          title_en: string
          updated_at: string | null
        }
        Insert: {
          author?: string | null
          category?: string | null
          content_cn?: string | null
          content_en: string
          created_at?: string | null
          excerpt_cn?: string | null
          excerpt_en?: string | null
          id?: string
          image_url?: string | null
          slug: string
          title_cn?: string | null
          title_en: string
          updated_at?: string | null
        }
        Update: {
          author?: string | null
          category?: string | null
          content_cn?: string | null
          content_en?: string
          created_at?: string | null
          excerpt_cn?: string | null
          excerpt_en?: string | null
          id?: string
          image_url?: string | null
          slug?: string
          title_cn?: string | null
          title_en?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      hmac_nonces: {
        Row: {
          created_at: string
          expires_at: string
          id: number
          nonce_hash: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: number
          nonce_hash: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: number
          nonce_hash?: string
        }
        Relationships: []
      }
      hospitals: {
        Row: {
          address_cn: string | null
          address_en: string | null
          banner_url: string | null
          card_url: string | null
          city: string | null
          created_at: string | null
          departments_ar: string[] | null
          departments_cn: string[] | null
          departments_en: string[] | null
          departments_es: string[] | null
          departments_ru: string[] | null
          description_cn: string | null
          description_en: string | null
          has_int_dept: boolean | null
          icon_url: string | null
          id: string
          int_dept: boolean | null
          is_available: boolean | null
          location: string | null
          name: string
          name_ar: string | null
          name_cn: string
          name_en: string | null
          name_es: string | null
          name_ru: string | null
          operating_hours_cn: string | null
          operating_hours_en: string | null
          specialties_ar: string[] | null
          specialties_cn: string[] | null
          specialties_en: string[] | null
          specialties_es: string[] | null
          specialties_ru: string[] | null
          subtitle_ar: string | null
          subtitle_cn: string | null
          subtitle_en: string | null
          subtitle_es: string | null
          subtitle_ru: string | null
          supports_direct_billing: boolean | null
          tags: string[] | null
          top_specialties: string[] | null
          type: string | null
          type_code: string | null
          updated_at: string | null
        }
        Insert: {
          address_cn?: string | null
          address_en?: string | null
          banner_url?: string | null
          card_url?: string | null
          city?: string | null
          created_at?: string | null
          departments_ar?: string[] | null
          departments_cn?: string[] | null
          departments_en?: string[] | null
          departments_es?: string[] | null
          departments_ru?: string[] | null
          description_cn?: string | null
          description_en?: string | null
          has_int_dept?: boolean | null
          icon_url?: string | null
          id: string
          int_dept?: boolean | null
          is_available?: boolean | null
          location?: string | null
          name: string
          name_ar?: string | null
          name_cn: string
          name_en?: string | null
          name_es?: string | null
          name_ru?: string | null
          operating_hours_cn?: string | null
          operating_hours_en?: string | null
          specialties_ar?: string[] | null
          specialties_cn?: string[] | null
          specialties_en?: string[] | null
          specialties_es?: string[] | null
          specialties_ru?: string[] | null
          subtitle_ar?: string | null
          subtitle_cn?: string | null
          subtitle_en?: string | null
          subtitle_es?: string | null
          subtitle_ru?: string | null
          supports_direct_billing?: boolean | null
          tags?: string[] | null
          top_specialties?: string[] | null
          type?: string | null
          type_code?: string | null
          updated_at?: string | null
        }
        Update: {
          address_cn?: string | null
          address_en?: string | null
          banner_url?: string | null
          card_url?: string | null
          city?: string | null
          created_at?: string | null
          departments_ar?: string[] | null
          departments_cn?: string[] | null
          departments_en?: string[] | null
          departments_es?: string[] | null
          departments_ru?: string[] | null
          description_cn?: string | null
          description_en?: string | null
          has_int_dept?: boolean | null
          icon_url?: string | null
          id?: string
          int_dept?: boolean | null
          is_available?: boolean | null
          location?: string | null
          name?: string
          name_ar?: string | null
          name_cn?: string
          name_en?: string | null
          name_es?: string | null
          name_ru?: string | null
          operating_hours_cn?: string | null
          operating_hours_en?: string | null
          specialties_ar?: string[] | null
          specialties_cn?: string[] | null
          specialties_en?: string[] | null
          specialties_es?: string[] | null
          specialties_ru?: string[] | null
          subtitle_ar?: string | null
          subtitle_cn?: string | null
          subtitle_en?: string | null
          subtitle_es?: string | null
          subtitle_ru?: string | null
          supports_direct_billing?: boolean | null
          tags?: string[] | null
          top_specialties?: string[] | null
          type?: string | null
          type_code?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      idempotency_keys: {
        Row: {
          created_at: string
          expires_at: string
          id: number
          idempotency_key: string
          response_body: Json
          route: string
          status_code: number
          user_id: string | null
        }
        Insert: {
          created_at?: string
          expires_at?: string
          id?: number
          idempotency_key: string
          response_body: Json
          route: string
          status_code: number
          user_id?: string | null
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: number
          idempotency_key?: string
          response_body?: Json
          route?: string
          status_code?: number
          user_id?: string | null
        }
        Relationships: []
      }
      notifications: {
        Row: {
          content_en: string
          content_zh: string
          created_at: string | null
          id: string
          is_read: boolean | null
          order_id: string | null
          title_en: string
          title_zh: string
          type: string | null
          user_id: string
        }
        Insert: {
          content_en: string
          content_zh: string
          created_at?: string | null
          id?: string
          is_read?: boolean | null
          order_id?: string | null
          title_en: string
          title_zh: string
          type?: string | null
          user_id: string
        }
        Update: {
          content_en?: string
          content_zh?: string
          created_at?: string | null
          id?: string
          is_read?: boolean | null
          order_id?: string | null
          title_en?: string
          title_zh?: string
          type?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      order_events: {
        Row: {
          actor_email: string | null
          actor_id: string | null
          created_at: string
          event_type: string
          from_status: string | null
          id: number
          metadata: Json
          order_id: string
          source: string
          to_status: string
        }
        Insert: {
          actor_email?: string | null
          actor_id?: string | null
          created_at?: string
          event_type: string
          from_status?: string | null
          id?: number
          metadata?: Json
          order_id: string
          source?: string
          to_status: string
        }
        Update: {
          actor_email?: string | null
          actor_id?: string | null
          created_at?: string
          event_type?: string
          from_status?: string | null
          id?: number
          metadata?: Json
          order_id?: string
          source?: string
          to_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_events_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          add_ons: string[] | null
          cancellation: Json | null
          chaperone_id: string | null
          checkup_package_id: string | null
          checkup_package_name: string | null
          checkup_package_name_cn: string | null
          commission_amount: number | null
          commission_rate: number | null
          commission_status: string | null
          commission_type: string | null
          consent_agreed_at: string | null
          consent_version: string | null
          created_at: string | null
          currency: string | null
          department_id: string | null
          department_name: string | null
          department_name_cn: string | null
          deposit_amount: number | null
          deposit_status: string | null
          doctor_id: string | null
          escort_name: string | null
          escort_name_cn: string | null
          extra_services: Json | null
          hospital_id: string | null
          hospital_name: string | null
          hospital_name_cn: string | null
          id: string
          is_subscription_order: boolean | null
          medical_service_type: string | null
          order_no: string | null
          paid_at: string | null
          payment: Json | null
          payment_intent_id: string | null
          promoter_id: string | null
          referral_code: string | null
          registration_info: Json | null
          reschedule_count: number
          review: Json | null
          scheduled_date: string | null
          service_ack_ip: string | null
          service_acknowledged_at: string | null
          service_completed_at: string | null
          service_confirm_ip: string | null
          service_confirm_user_agent: string | null
          service_confirmed_at: string | null
          service_details: Json | null
          service_id: string | null
          service_type: string | null
          source: string | null
          special_requests: string | null
          status: string | null
          submission_ip: string | null
          submission_user_agent: string | null
          subscription_interval: string | null
          total_amount: number | null
          updated_at: string | null
          upgrade_grade: string | null
          user_id: string | null
          user_info: Json | null
          wellness_package_name: string | null
          wellness_package_name_cn: string | null
        }
        Insert: {
          add_ons?: string[] | null
          cancellation?: Json | null
          chaperone_id?: string | null
          checkup_package_id?: string | null
          checkup_package_name?: string | null
          checkup_package_name_cn?: string | null
          commission_amount?: number | null
          commission_rate?: number | null
          commission_status?: string | null
          commission_type?: string | null
          consent_agreed_at?: string | null
          consent_version?: string | null
          created_at?: string | null
          currency?: string | null
          department_id?: string | null
          department_name?: string | null
          department_name_cn?: string | null
          deposit_amount?: number | null
          deposit_status?: string | null
          doctor_id?: string | null
          escort_name?: string | null
          escort_name_cn?: string | null
          extra_services?: Json | null
          hospital_id?: string | null
          hospital_name?: string | null
          hospital_name_cn?: string | null
          id?: string
          is_subscription_order?: boolean | null
          medical_service_type?: string | null
          order_no?: string | null
          paid_at?: string | null
          payment?: Json | null
          payment_intent_id?: string | null
          promoter_id?: string | null
          referral_code?: string | null
          registration_info?: Json | null
          reschedule_count?: number
          review?: Json | null
          scheduled_date?: string | null
          service_ack_ip?: string | null
          service_acknowledged_at?: string | null
          service_completed_at?: string | null
          service_confirm_ip?: string | null
          service_confirm_user_agent?: string | null
          service_confirmed_at?: string | null
          service_details?: Json | null
          service_id?: string | null
          service_type?: string | null
          source?: string | null
          special_requests?: string | null
          status?: string | null
          submission_ip?: string | null
          submission_user_agent?: string | null
          subscription_interval?: string | null
          total_amount?: number | null
          updated_at?: string | null
          upgrade_grade?: string | null
          user_id?: string | null
          user_info?: Json | null
          wellness_package_name?: string | null
          wellness_package_name_cn?: string | null
        }
        Update: {
          add_ons?: string[] | null
          cancellation?: Json | null
          chaperone_id?: string | null
          checkup_package_id?: string | null
          checkup_package_name?: string | null
          checkup_package_name_cn?: string | null
          commission_amount?: number | null
          commission_rate?: number | null
          commission_status?: string | null
          commission_type?: string | null
          consent_agreed_at?: string | null
          consent_version?: string | null
          created_at?: string | null
          currency?: string | null
          department_id?: string | null
          department_name?: string | null
          department_name_cn?: string | null
          deposit_amount?: number | null
          deposit_status?: string | null
          doctor_id?: string | null
          escort_name?: string | null
          escort_name_cn?: string | null
          extra_services?: Json | null
          hospital_id?: string | null
          hospital_name?: string | null
          hospital_name_cn?: string | null
          id?: string
          is_subscription_order?: boolean | null
          medical_service_type?: string | null
          order_no?: string | null
          paid_at?: string | null
          payment?: Json | null
          payment_intent_id?: string | null
          promoter_id?: string | null
          referral_code?: string | null
          registration_info?: Json | null
          reschedule_count?: number
          review?: Json | null
          scheduled_date?: string | null
          service_ack_ip?: string | null
          service_acknowledged_at?: string | null
          service_completed_at?: string | null
          service_confirm_ip?: string | null
          service_confirm_user_agent?: string | null
          service_confirmed_at?: string | null
          service_details?: Json | null
          service_id?: string | null
          service_type?: string | null
          source?: string | null
          special_requests?: string | null
          status?: string | null
          submission_ip?: string | null
          submission_user_agent?: string | null
          subscription_interval?: string | null
          total_amount?: number | null
          updated_at?: string | null
          upgrade_grade?: string | null
          user_id?: string | null
          user_info?: Json | null
          wellness_package_name?: string | null
          wellness_package_name_cn?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "orders_checkup_package_id_fkey"
            columns: ["checkup_package_id"]
            isOneToOne: false
            referencedRelation: "checkup_packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
        ]
      }
      partner_submissions: {
        Row: {
          city: string
          company: string
          country: string
          created_at: string
          email: string
          id: string
          message: string
          name: string
          partner_type: string
          status: string
        }
        Insert: {
          city: string
          company: string
          country: string
          created_at?: string
          email: string
          id?: string
          message: string
          name: string
          partner_type: string
          status?: string
        }
        Update: {
          city?: string
          company?: string
          country?: string
          created_at?: string
          email?: string
          id?: string
          message?: string
          name?: string
          partner_type?: string
          status?: string
        }
        Relationships: []
      }
      processed_stripe_events: {
        Row: {
          endpoint: string
          event_id: string
          processed_at: string
        }
        Insert: {
          endpoint: string
          event_id: string
          processed_at?: string
        }
        Update: {
          endpoint?: string
          event_id?: string
          processed_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string | null
          email: string | null
          full_name: string | null
          id: string
          is_active: boolean | null
          is_admin: boolean | null
          is_pro: boolean | null
          pro_expires_at: string | null
          referred_by: string | null
          role: Database["public"]["Enums"]["user_role"] | null
          stripe_customer_id: string | null
          totp_enabled: boolean | null
          totp_secret: string | null
          totp_verified_at: string | null
          updated_at: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string | null
          email?: string | null
          full_name?: string | null
          id: string
          is_active?: boolean | null
          is_admin?: boolean | null
          is_pro?: boolean | null
          pro_expires_at?: string | null
          referred_by?: string | null
          role?: Database["public"]["Enums"]["user_role"] | null
          stripe_customer_id?: string | null
          totp_enabled?: boolean | null
          totp_secret?: string | null
          totp_verified_at?: string | null
          updated_at?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string | null
          email?: string | null
          full_name?: string | null
          id?: string
          is_active?: boolean | null
          is_admin?: boolean | null
          is_pro?: boolean | null
          pro_expires_at?: string | null
          referred_by?: string | null
          role?: Database["public"]["Enums"]["user_role"] | null
          stripe_customer_id?: string | null
          totp_enabled?: boolean | null
          totp_secret?: string | null
          totp_verified_at?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      rate_limit_buckets: {
        Row: {
          bucket_key: string
          count: number
          window_start: string
        }
        Insert: {
          bucket_key: string
          count?: number
          window_start?: string
        }
        Update: {
          bucket_key?: string
          count?: number
          window_start?: string
        }
        Relationships: []
      }
      refund_request_events: {
        Row: {
          actor_id: string | null
          created_at: string
          event_type: string
          from_status: string | null
          id: number
          metadata: Json | null
          refund_id: string
          to_status: string | null
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          event_type: string
          from_status?: string | null
          id?: number
          metadata?: Json | null
          refund_id: string
          to_status?: string | null
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          event_type?: string
          from_status?: string | null
          id?: number
          metadata?: Json | null
          refund_id?: string
          to_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "refund_request_events_refund_id_fkey"
            columns: ["refund_id"]
            isOneToOne: false
            referencedRelation: "refund_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      refund_request_messages: {
        Row: {
          body: string
          created_at: string
          id: number
          refund_id: string
          sender_id: string
          sender_role: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: number
          refund_id: string
          sender_id: string
          sender_role: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: number
          refund_id?: string
          sender_id?: string
          sender_role?: string
        }
        Relationships: [
          {
            foreignKeyName: "refund_request_messages_refund_id_fkey"
            columns: ["refund_id"]
            isOneToOne: false
            referencedRelation: "refund_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      refund_requests: {
        Row: {
          admin_notes: string | null
          amount_cents: number
          approved_at: string | null
          approved_by: string | null
          approved_cents: number | null
          completed_at: string | null
          consent_agreed_at: string
          consent_ip: unknown
          consent_user_agent: string | null
          consent_version: string
          created_at: string
          id: string
          idempotency_key: string | null
          order_id: string
          policy_version: string
          prior_reschedules: number
          prior_upgrades: boolean
          reason_code: string
          reason_text: string | null
          refund_window: string
          rejected_at: string | null
          rejected_by: string | null
          rejection_reason: string | null
          sla_decision_deadline: string | null
          sla_response_deadline: string | null
          status: string
          stripe_payment_intent: string | null
          stripe_refund_id: string | null
          submitted_at: string
          two_step_confirmed: boolean
          updated_at: string
          user_id: string
          withdrawn_at: string | null
        }
        Insert: {
          admin_notes?: string | null
          amount_cents: number
          approved_at?: string | null
          approved_by?: string | null
          approved_cents?: number | null
          completed_at?: string | null
          consent_agreed_at: string
          consent_ip?: unknown
          consent_user_agent?: string | null
          consent_version: string
          created_at?: string
          id?: string
          idempotency_key?: string | null
          order_id: string
          policy_version?: string
          prior_reschedules?: number
          prior_upgrades?: boolean
          reason_code: string
          reason_text?: string | null
          refund_window: string
          rejected_at?: string | null
          rejected_by?: string | null
          rejection_reason?: string | null
          sla_decision_deadline?: string | null
          sla_response_deadline?: string | null
          status?: string
          stripe_payment_intent?: string | null
          stripe_refund_id?: string | null
          submitted_at?: string
          two_step_confirmed?: boolean
          updated_at?: string
          user_id: string
          withdrawn_at?: string | null
        }
        Update: {
          admin_notes?: string | null
          amount_cents?: number
          approved_at?: string | null
          approved_by?: string | null
          approved_cents?: number | null
          completed_at?: string | null
          consent_agreed_at?: string
          consent_ip?: unknown
          consent_user_agent?: string | null
          consent_version?: string
          created_at?: string
          id?: string
          idempotency_key?: string | null
          order_id?: string
          policy_version?: string
          prior_reschedules?: number
          prior_upgrades?: boolean
          reason_code?: string
          reason_text?: string | null
          refund_window?: string
          rejected_at?: string | null
          rejected_by?: string | null
          rejection_reason?: string | null
          sla_decision_deadline?: string | null
          sla_response_deadline?: string | null
          status?: string
          stripe_payment_intent?: string | null
          stripe_refund_id?: string | null
          submitted_at?: string
          two_step_confirmed?: boolean
          updated_at?: string
          user_id?: string
          withdrawn_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "refund_requests_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: true
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      service_items: {
        Row: {
          banner_url: string | null
          card_url: string | null
          created_at: string | null
          currency: string | null
          description: string | null
          description_cn: string | null
          icon_url: string | null
          id: string
          is_active: boolean | null
          is_popular: boolean | null
          name: string
          name_cn: string | null
          original_price: number | null
          price: number | null
          sort_order: number | null
          updated_at: string | null
        }
        Insert: {
          banner_url?: string | null
          card_url?: string | null
          created_at?: string | null
          currency?: string | null
          description?: string | null
          description_cn?: string | null
          icon_url?: string | null
          id?: string
          is_active?: boolean | null
          is_popular?: boolean | null
          name: string
          name_cn?: string | null
          original_price?: number | null
          price?: number | null
          sort_order?: number | null
          updated_at?: string | null
        }
        Update: {
          banner_url?: string | null
          card_url?: string | null
          created_at?: string | null
          currency?: string | null
          description?: string | null
          description_cn?: string | null
          icon_url?: string | null
          id?: string
          is_active?: boolean | null
          is_popular?: boolean | null
          name?: string
          name_cn?: string | null
          original_price?: number | null
          price?: number | null
          sort_order?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      service_reschedules: {
        Row: {
          created_at: string
          id: string
          new_scheduled_date: string
          old_scheduled_date: string
          order_id: string
          reason: string
          reschedule_num: number
          rescheduled_at: string
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          new_scheduled_date: string
          old_scheduled_date: string
          order_id: string
          reason: string
          reschedule_num: number
          rescheduled_at?: string
          status?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          new_scheduled_date?: string
          old_scheduled_date?: string
          order_id?: string
          reason?: string
          reschedule_num?: number
          rescheduled_at?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_reschedules_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      service_upgrades: {
        Row: {
          compensation_type: string
          from_grade: string
          id: string
          order_id: string
          reason: string
          to_grade: string
          triggered_by: string
          upgraded_at: string
        }
        Insert: {
          compensation_type: string
          from_grade: string
          id?: string
          order_id: string
          reason: string
          to_grade: string
          triggered_by: string
          upgraded_at?: string
        }
        Update: {
          compensation_type?: string
          from_grade?: string
          id?: string
          order_id?: string
          reason?: string
          to_grade?: string
          triggered_by?: string
          upgraded_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_upgrades_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: true
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          created_at: string | null
          expires_date: string | null
          id: string
          jws_representation: string | null
          original_transaction_id: string | null
          product_id: string
          purchase_date: string
          raw_json: Json | null
          status: string | null
          transaction_id: string
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          expires_date?: string | null
          id?: string
          jws_representation?: string | null
          original_transaction_id?: string | null
          product_id: string
          purchase_date: string
          raw_json?: Json | null
          status?: string | null
          transaction_id: string
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          expires_date?: string | null
          id?: string
          jws_representation?: string | null
          original_transaction_id?: string | null
          product_id?: string
          purchase_date?: string
          raw_json?: Json | null
          status?: string | null
          transaction_id?: string
          user_id?: string | null
        }
        Relationships: []
      }
      timeline_events: {
        Row: {
          created_at: string | null
          description: string | null
          event_date: string | null
          id: string
          quote_id: string | null
          status: string
          title: string
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          event_date?: string | null
          id?: string
          quote_id?: string | null
          status?: string
          title: string
        }
        Update: {
          created_at?: string | null
          description?: string | null
          event_date?: string | null
          id?: string
          quote_id?: string | null
          status?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "timeline_events_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "custom_quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      webchat_messages: {
        Row: {
          content: string
          created_at: string | null
          id: string
          is_read: boolean | null
          msg_type: string | null
          sender_name: string | null
          sender_type: string
          session_id: string
          wecom_msg_id: string | null
        }
        Insert: {
          content: string
          created_at?: string | null
          id?: string
          is_read?: boolean | null
          msg_type?: string | null
          sender_name?: string | null
          sender_type: string
          session_id: string
          wecom_msg_id?: string | null
        }
        Update: {
          content?: string
          created_at?: string | null
          id?: string
          is_read?: boolean | null
          msg_type?: string | null
          sender_name?: string | null
          sender_type?: string
          session_id?: string
          wecom_msg_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "webchat_messages_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "v_open_webchat_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "webchat_messages_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "webchat_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      webchat_sessions: {
        Row: {
          created_at: string | null
          id: string
          last_active_at: string | null
          referrer_url: string | null
          status: string | null
          visitor_email: string | null
          visitor_id: string
          visitor_lang: string | null
          visitor_name: string | null
          wecom_kf_id: string | null
          wecom_open_kfid: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          last_active_at?: string | null
          referrer_url?: string | null
          status?: string | null
          visitor_email?: string | null
          visitor_id: string
          visitor_lang?: string | null
          visitor_name?: string | null
          wecom_kf_id?: string | null
          wecom_open_kfid?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          last_active_at?: string | null
          referrer_url?: string | null
          status?: string | null
          visitor_email?: string | null
          visitor_id?: string
          visitor_lang?: string | null
          visitor_name?: string | null
          wecom_kf_id?: string | null
          wecom_open_kfid?: string | null
        }
        Relationships: []
      }
      wellness_activities: {
        Row: {
          category: string
          created_at: string | null
          description_cn: string | null
          description_en: string | null
          description_images: Json | null
          duration: string | null
          emoji: string | null
          health_tip_1: string | null
          health_tip_1_cn: string | null
          health_tip_1_en: string | null
          health_tip_2: string | null
          health_tip_2_cn: string | null
          health_tip_2_en: string | null
          health_tip_3: string | null
          health_tip_3_cn: string | null
          health_tip_3_en: string | null
          highlight_1: string | null
          highlight_1_cn: string | null
          highlight_1_en: string | null
          highlight_2: string | null
          highlight_2_cn: string | null
          highlight_2_en: string | null
          highlight_3: string | null
          highlight_3_cn: string | null
          highlight_3_en: string | null
          highlight_4: string | null
          highlight_4_cn: string | null
          highlight_4_en: string | null
          id: string
          image_url: string | null
          intensity: string
          is_active: boolean | null
          sort_order: number | null
          subtitle: string | null
          subtitle_cn: string | null
          subtitle_en: string | null
          title_cn: string
          title_en: string
          updated_at: string | null
        }
        Insert: {
          category?: string
          created_at?: string | null
          description_cn?: string | null
          description_en?: string | null
          description_images?: Json | null
          duration?: string | null
          emoji?: string | null
          health_tip_1?: string | null
          health_tip_1_cn?: string | null
          health_tip_1_en?: string | null
          health_tip_2?: string | null
          health_tip_2_cn?: string | null
          health_tip_2_en?: string | null
          health_tip_3?: string | null
          health_tip_3_cn?: string | null
          health_tip_3_en?: string | null
          highlight_1?: string | null
          highlight_1_cn?: string | null
          highlight_1_en?: string | null
          highlight_2?: string | null
          highlight_2_cn?: string | null
          highlight_2_en?: string | null
          highlight_3?: string | null
          highlight_3_cn?: string | null
          highlight_3_en?: string | null
          highlight_4?: string | null
          highlight_4_cn?: string | null
          highlight_4_en?: string | null
          id?: string
          image_url?: string | null
          intensity?: string
          is_active?: boolean | null
          sort_order?: number | null
          subtitle?: string | null
          subtitle_cn?: string | null
          subtitle_en?: string | null
          title_cn?: string
          title_en?: string
          updated_at?: string | null
        }
        Update: {
          category?: string
          created_at?: string | null
          description_cn?: string | null
          description_en?: string | null
          description_images?: Json | null
          duration?: string | null
          emoji?: string | null
          health_tip_1?: string | null
          health_tip_1_cn?: string | null
          health_tip_1_en?: string | null
          health_tip_2?: string | null
          health_tip_2_cn?: string | null
          health_tip_2_en?: string | null
          health_tip_3?: string | null
          health_tip_3_cn?: string | null
          health_tip_3_en?: string | null
          highlight_1?: string | null
          highlight_1_cn?: string | null
          highlight_1_en?: string | null
          highlight_2?: string | null
          highlight_2_cn?: string | null
          highlight_2_en?: string | null
          highlight_3?: string | null
          highlight_3_cn?: string | null
          highlight_3_en?: string | null
          highlight_4?: string | null
          highlight_4_cn?: string | null
          highlight_4_en?: string | null
          id?: string
          image_url?: string | null
          intensity?: string
          is_active?: boolean | null
          sort_order?: number | null
          subtitle?: string | null
          subtitle_cn?: string | null
          subtitle_en?: string | null
          title_cn?: string
          title_en?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      wellness_banners: {
        Row: {
          created_at: string | null
          id: string
          image_url: string | null
          is_active: boolean | null
          link_type: string | null
          link_value: string | null
          sort_order: number | null
          subtitle_cn: string | null
          subtitle_en: string | null
          title_cn: string
          title_en: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean | null
          link_type?: string | null
          link_value?: string | null
          sort_order?: number | null
          subtitle_cn?: string | null
          subtitle_en?: string | null
          title_cn?: string
          title_en?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean | null
          link_type?: string | null
          link_value?: string | null
          sort_order?: number | null
          subtitle_cn?: string | null
          subtitle_en?: string | null
          title_cn?: string
          title_en?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      wellness_categories: {
        Row: {
          created_at: string | null
          emoji: string | null
          id: string
          is_active: boolean | null
          key: string
          name_cn: string
          name_en: string
          sort_order: number | null
          subtitle_cn: string | null
        }
        Insert: {
          created_at?: string | null
          emoji?: string | null
          id?: string
          is_active?: boolean | null
          key?: string
          name_cn?: string
          name_en?: string
          sort_order?: number | null
          subtitle_cn?: string | null
        }
        Update: {
          created_at?: string | null
          emoji?: string | null
          id?: string
          is_active?: boolean | null
          key?: string
          name_cn?: string
          name_en?: string
          sort_order?: number | null
          subtitle_cn?: string | null
        }
        Relationships: []
      }
      wellness_packages: {
        Row: {
          category: string
          created_at: string | null
          description: string | null
          description_ar: string | null
          description_en: string | null
          description_es: string | null
          description_ru: string | null
          duration_hours: number | null
          emoji: string | null
          highlights: string[] | null
          highlights_ar: string[] | null
          highlights_en: Json | null
          highlights_es: string[] | null
          highlights_ru: string[] | null
          id: string
          is_recommended: boolean | null
          items: Json | null
          max_participants: number | null
          name: string
          name_ar: string | null
          name_en: string | null
          name_es: string | null
          name_ru: string | null
          price: number | null
          sort_order: number | null
          suitable_for: string[] | null
          suitable_for_ar: string[] | null
          suitable_for_en: Json | null
          suitable_for_es: string[] | null
          suitable_for_ru: string[] | null
          tagline: string | null
          tagline_ar: string | null
          tagline_en: string | null
          tagline_es: string | null
          tagline_ru: string | null
          updated_at: string | null
        }
        Insert: {
          category?: string
          created_at?: string | null
          description?: string | null
          description_ar?: string | null
          description_en?: string | null
          description_es?: string | null
          description_ru?: string | null
          duration_hours?: number | null
          emoji?: string | null
          highlights?: string[] | null
          highlights_ar?: string[] | null
          highlights_en?: Json | null
          highlights_es?: string[] | null
          highlights_ru?: string[] | null
          id?: string
          is_recommended?: boolean | null
          items?: Json | null
          max_participants?: number | null
          name?: string
          name_ar?: string | null
          name_en?: string | null
          name_es?: string | null
          name_ru?: string | null
          price?: number | null
          sort_order?: number | null
          suitable_for?: string[] | null
          suitable_for_ar?: string[] | null
          suitable_for_en?: Json | null
          suitable_for_es?: string[] | null
          suitable_for_ru?: string[] | null
          tagline?: string | null
          tagline_ar?: string | null
          tagline_en?: string | null
          tagline_es?: string | null
          tagline_ru?: string | null
          updated_at?: string | null
        }
        Update: {
          category?: string
          created_at?: string | null
          description?: string | null
          description_ar?: string | null
          description_en?: string | null
          description_es?: string | null
          description_ru?: string | null
          duration_hours?: number | null
          emoji?: string | null
          highlights?: string[] | null
          highlights_ar?: string[] | null
          highlights_en?: Json | null
          highlights_es?: string[] | null
          highlights_ru?: string[] | null
          id?: string
          is_recommended?: boolean | null
          items?: Json | null
          max_participants?: number | null
          name?: string
          name_ar?: string | null
          name_en?: string | null
          name_es?: string | null
          name_ru?: string | null
          price?: number | null
          sort_order?: number | null
          suitable_for?: string[] | null
          suitable_for_ar?: string[] | null
          suitable_for_en?: Json | null
          suitable_for_es?: string[] | null
          suitable_for_ru?: string[] | null
          tagline?: string | null
          tagline_ar?: string | null
          tagline_en?: string | null
          tagline_es?: string | null
          tagline_ru?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      v_ci_case_unread_counts: {
        Row: {
          case_id: string | null
          unread_from_admin: number | null
          unread_from_user: number | null
        }
        Relationships: [
          {
            foreignKeyName: "ci_messages_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "critical_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      v_open_webchat_sessions: {
        Row: {
          created_at: string | null
          id: string | null
          last_active_at: string | null
          last_message: string | null
          referrer_url: string | null
          status: string | null
          unread_count: number | null
          visitor_email: string | null
          visitor_lang: string | null
          visitor_name: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string | null
          last_active_at?: string | null
          last_message?: never
          referrer_url?: string | null
          status?: string | null
          unread_count?: never
          visitor_email?: string | null
          visitor_lang?: string | null
          visitor_name?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string | null
          last_active_at?: string | null
          last_message?: never
          referrer_url?: string | null
          status?: string | null
          unread_count?: never
          visitor_email?: string | null
          visitor_lang?: string | null
          visitor_name?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      affiliate_activate_promoter: { Args: { p_id: string }; Returns: Json }
      affiliate_agent_create_kol: {
        Args: {
          p_agent_promoter_id: string
          p_bio?: string
          p_brand_name?: string
          p_commission_rate?: number
          p_country_code?: string
          p_email: string
          p_name: string
          p_phone?: string
          p_primary_platform?: string
          p_primary_platform_url?: string
        }
        Returns: Json
      }
      affiliate_approve_commission: {
        Args: { p_id: string; p_reason: string }
        Returns: Json
      }
      affiliate_create_promoter:
        | {
            Args: {
              p_bio?: string
              p_brand_name?: string
              p_country_code?: string
              p_email: string
              p_name: string
              p_phone?: string
              p_primary_platform?: string
              p_primary_platform_url?: string
            }
            Returns: Json
          }
        | {
            Args: {
              p_auth_user_id?: string
              p_bio?: string
              p_brand_name?: string
              p_commission_rate?: number
              p_country_code?: string
              p_email: string
              p_name: string
              p_phone?: string
              p_primary_platform?: string
              p_primary_platform_url?: string
              p_role?: string
            }
            Returns: Json
          }
        | {
            Args: {
              p_agent_level?: string
              p_auth_user_id?: string
              p_bio?: string
              p_brand_name?: string
              p_commission_rate?: number
              p_country_code?: string
              p_email: string
              p_name: string
              p_phone?: string
              p_primary_platform?: string
              p_primary_platform_url?: string
              p_role?: string
            }
            Returns: Json
          }
      affiliate_get_dashboard_stats: { Args: never; Returns: Json }
      affiliate_get_me: { Args: { p_promoter_id: string }; Returns: Json }
      affiliate_get_my_codes: { Args: { p_promoter_id: string }; Returns: Json }
      affiliate_get_my_earnings: {
        Args: { p_promoter_id: string }
        Returns: Json
      }
      affiliate_get_my_payouts: {
        Args: { p_promoter_id: string }
        Returns: Json
      }
      affiliate_get_my_stats: { Args: { p_promoter_id: string }; Returns: Json }
      affiliate_get_promoter: { Args: { p_id: string }; Returns: Json }
      affiliate_get_promoter_by_email: {
        Args: { p_email: string }
        Returns: Database["affiliate"]["Tables"]["promoters"]["Row"][]
        SetofOptions: {
          from: "*"
          to: "promoters"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      affiliate_list_audit_logs: {
        Args: {
          p_action?: string
          p_actor?: string
          p_from?: string
          p_limit?: number
          p_offset?: number
          p_target_id?: string
          p_target_type?: string
          p_to?: string
        }
        Returns: Json
      }
      affiliate_list_codes: {
        Args: {
          p_is_active?: boolean
          p_limit?: number
          p_offset?: number
          p_promoter_id?: string
        }
        Returns: Json
      }
      affiliate_list_commissions: {
        Args: {
          p_from?: string
          p_limit?: number
          p_month_key?: string
          p_offset?: number
          p_promoter_id?: string
          p_status?: string
          p_to?: string
        }
        Returns: Json
      }
      affiliate_list_payouts: {
        Args: { p_limit?: number; p_month_key?: string; p_offset?: number }
        Returns: Json
      }
      affiliate_list_promoters: {
        Args: {
          p_limit?: number
          p_offset?: number
          p_platform?: string
          p_search?: string
          p_status?: string
        }
        Returns: Json
      }
      affiliate_list_refunds: {
        Args: { p_limit?: number; p_offset?: number }
        Returns: Json
      }
      affiliate_reverse_commission: {
        Args: { p_id: string; p_reason: string }
        Returns: Json
      }
      affiliate_self_register_promoter:
        | {
            Args: {
              p_auth_user_id: string
              p_country: string
              p_email: string
              p_name: string
              p_platform: string
              p_platform_url: string
            }
            Returns: Json
          }
        | {
            Args: {
              p_auth_user_id: string
              p_country: string
              p_email: string
              p_name: string
              p_platform: string
              p_platform_url: string
              p_recruited_by_agent_id?: string
            }
            Returns: Json
          }
        | {
            Args: {
              p_aa_template_id?: string
              p_auth_user_id: string
              p_country: string
              p_email: string
              p_name: string
              p_nda_template_id?: string
              p_platform: string
              p_platform_url: string
              p_recruited_by_agent_id?: string
              p_signed_ip?: unknown
              p_signed_ua?: string
            }
            Returns: Json
          }
      affiliate_suspend_promoter: {
        Args: { p_id: string; p_reason: string }
        Returns: Json
      }
      affiliate_track_click: {
        Args: {
          p_country?: string
          p_ip_address?: string
          p_referral_code: string
          p_user_agent?: string
          p_visitor_session_id: string
        }
        Returns: Json
      }
      affiliate_update_promoter: {
        Args: {
          p_actor_id?: string
          p_commission_rate?: number
          p_commission_type?: string
          p_id: string
          p_override_reason?: string
          p_status?: string
        }
        Returns: Json
      }
      auth_is_admin: { Args: never; Returns: boolean }
      calculate_refund_eligibility: {
        Args: { p_now?: string; p_order_id: string }
        Returns: Json
      }
      generate_case_no: { Args: never; Returns: string }
      get_admin_users: {
        Args: never
        Returns: {
          created_at: string
          email: string
          id: string
          is_active: boolean
          last_sign_in_at: string
          role: string
        }[]
      }
      get_customer_accounts: {
        Args: { p_limit?: number; p_page?: number }
        Returns: {
          created_at: string
          email: string
          id: string
          is_active: boolean
          last_sign_in_at: string
          role: string
          total_count: number
        }[]
      }
      get_escort_monthly_schedule: {
        Args: { p_month: number; p_year: number }
        Returns: {
          escort_id: string
          escort_name: string
          is_available: boolean
          orders_count: number
          schedule_date: string
          unavailability_reason: string
        }[]
      }
      get_guest_order: {
        Args: { p_email: string; p_order_no: string }
        Returns: Json
      }
      get_order_passport: { Args: { p_order_id: string }; Returns: string }
      get_staff_accounts: {
        Args: never
        Returns: {
          created_at: string
          email: string
          id: string
          is_active: boolean
          last_sign_in_at: string
          mfa_enabled: boolean
          role: string
        }[]
      }
      get_user_passport: { Args: { p_user_id: string }; Returns: string }
      hmac_nonces_cleanup: { Args: never; Returns: number }
      increment_promoter_stats: {
        Args: { p_earned: number; p_promoter_id: string }
        Returns: undefined
      }
      is_admin: { Args: never; Returns: boolean }
      purge_due_account_deletions: { Args: never; Returns: number }
      rate_limit_cleanup: { Args: never; Returns: number }
      rate_limit_consume: {
        Args: { p_key: string; p_limit: number; p_window_seconds: number }
        Returns: {
          allowed: boolean
          remaining: number
          retry_after_seconds: number
        }[]
      }
      reload_pgrst_schema: { Args: never; Returns: undefined }
      write_admin_audit_log: {
        Args: {
          p_action: string
          p_after?: Json
          p_before?: Json
          p_ip_address?: unknown
          p_reason?: string
          p_target_id: string
          p_target_type: string
          p_user_agent?: string
        }
        Returns: string
      }
    }
    Enums: {
      user_role: "user" | "admin" | "ops"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  affiliate: {
    Enums: {},
  },
  documents: {
    Enums: {},
  },
  public: {
    Enums: {
      user_role: ["user", "admin", "ops"],
    },
  },
} as const
